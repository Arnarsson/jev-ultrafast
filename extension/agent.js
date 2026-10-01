// The complete agent loop. Port of jev_ultrafast/agent.py: typed choices, bounded execution.

import { StalePage } from "./browser.js";
import { MAX_STEPS, NoFieldValue, choose, fieldContext, fieldText } from "./policy.js";
import { seriousReason } from "./guard.js";
import { sameStep, structural } from "./recipes.js";

const actionKey = (a) => `${a.kind}|${a.node}|${a.label}`;

export class Agent {
  // learned: { recipe, exact } from recipes.findRecipe, or null.
  // approve(request) -> Promise<boolean> asks the user before serious actions; without it they are refused.
  constructor(browser, goal, settings, onUpdate = () => {}, { learned = null, approve = async () => false } = {}) {
    if (!goal.trim()) throw new Error("Supply a task");
    this.browser = browser;
    this.settings = settings;
    this.onUpdate = onUpdate;
    this.pendingText = null;
    this.stopped = false;
    // Actions that changed nothing since the page last changed. Not offered again until an action has an effect.
    // Keyed by element and label, not snapshot: live pages (prices, timers) re-render without a real change.
    this.ineffective = new Set();
    this.recipe = learned?.recipe ?? null;
    this.exact = learned?.exact ?? false;
    this.pointer = 0;
    this.approve = approve;
    this.approved = new Set(); // elements the user approved in this run; not asked twice
    this.state = {
      goal: goal.trim(), page: null, decision: null, history: [], decisions: [], text_calls: [],
      status: "ready", elapsed_ms: 0, started_at: null, error: null,
    };
  }

  elapsed() {
    return Math.round(performance.now() - this.state.started_at);
  }

  async tick() {
    const state = this.state;
    try {
      await this.predict();
      await this.act();
    } catch (error) {
      if (!(error instanceof StalePage)) throw error;
      state.stale = [...(state.stale ?? []), error.message].slice(-20);
      // Keep the rejected decision: if the page only settled (prices, animations), it can run without a new model call.
      this.retry = this.lastDecision;
      this.lastDecision = null;
      state.decision = null;
      state.status = "ready";
      state.page = await this.browser.observe();
      state.elapsed_ms = this.elapsed();
    }
  }

  async predict() {
    const state = this.state;
    if (!(await this.browser.fresh(state.page))) state.page = await this.browser.observe();
    state.decision = null;
    if (state.decisions.length >= MAX_STEPS * 2) throw new Error("Reached the decision budget");
    const reused = this.reuse(state.page) ?? this.replay(state.page);
    if (reused) {
      // Not recorded as lastDecision: if this goes stale too, the model chooses again.
      state.decision = reused;
      state.decisions.push({ ...reused, fingerprint: state.page.fingerprint, elapsed_ms: this.elapsed() });
      state.status = "predicted";
      this.onUpdate(state);
      return;
    }
    const page = { ...state.page, actions: state.page.actions.filter((a) => !this.ineffective.has(actionKey(a))) };
    state.decision = await choose(page, state.goal, state.history, this.settings);
    state.decisions.push({ ...state.decision, fingerprint: state.page.fingerprint, elapsed_ms: this.elapsed() });
    this.lastDecision = { decision: state.decision, page: state.page };
    state.status = "predicted";
    this.onUpdate(state);
  }

  // The next learned step, when its exact element is on the page. Value steps replay only in exact mode.
  replay(page) {
    const step = this.recipe?.steps[this.pointer];
    if (!step || (!this.exact && !structural(step, this.recipe))) return null;
    const action = page.actions.find((a) => sameStep(step, a) && !this.ineffective.has(actionKey(a)));
    if (!action) return null;
    if (action.kind === "fill" && action.value && !this.exact) {
      // Already filled (e.g. Google prefills your city): the model judges whether it fits this goal.
      this.pointer++;
      return null;
    }
    return {
      choice: action.id, operation: step.operation, target: null, confidence: null,
      probabilities: { [action.id]: null }, latency_ms: 0, replayed: true, step,
    };
  }

  // A stale decision is reused once, only if its element is still there and nothing new appeared
  // (a new autocomplete list or dialog deserves a fresh choice). act() still checks freshness before input.
  reuse(page) {
    const retry = this.retry;
    this.retry = null;
    if (!retry) return null;
    const miss = (reason) => ((this.state.reuse_misses ||= []).push(reason), null);
    const { decision, page: old } = retry;
    const before = new Set(old.actions.map((a) => a.node).filter((n) => n != null));
    // Query strings change as fields commit (Google Flights rewrites ?tfs=); new elements are checked below.
    const where = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; } };
    if (where(page.url) !== where(old.url)) return miss("url");
    const added = page.actions.filter((a) => a.node != null && !before.has(a.node));
    if (added.length) return miss(`new elements: ${added.slice(0, 3).map((a) => a.label).join(" | ")}`);
    let choice = decision.choice;
    if (choice === "BLOCKED") return miss("blocked");
    if (choice === "DONE") {
      if (page.title !== old.title) return miss("title");
    } else {
      const chosen = old.actions.find((a) => a.id === choice);
      // Same element; a label may only grow or shrink by loaded detail ("Nov 5" -> "Nov 5, 9,356 kr").
      const now = chosen && page.actions.find((a) => a.kind === chosen.kind && a.node === chosen.node &&
        (a.label.startsWith(chosen.label) || chosen.label.startsWith(a.label)));
      if (!now) return miss(`gone: ${chosen?.label}`);
      if (this.ineffective.has(actionKey(now))) return miss("ineffective");
      choice = now.id;
    }
    return {
      ...decision, choice, latency_ms: 0, reused: true,
      probabilities: { [choice]: decision.probabilities[decision.choice] },
    };
  }

  async act() {
    const state = this.state;
    const { decision, page } = state;
    // Consume once, before any mutation or model call. A retry cannot double-click.
    state.decision = null;
    const selected = decision.choice;
    if (selected === "DONE" || selected === "BLOCKED") {
      if (!(await this.browser.fresh(page))) {
        state.status = "ready";
        throw new StalePage("Page changed since the decision. Choose again.");
      }
      this.lastDecision = null;
      state.status = selected === "DONE" ? "done" : "blocked";
      state.elapsed_ms = this.elapsed();
      return;
    }
    const action = page.actions.find((a) => a.id === selected);
    if (state.history.length >= MAX_STEPS) {
      state.status = "blocked";
      throw new Error(`Stopped at the ${MAX_STEPS}-action budget`);
    }
    let text = null, helper = null;
    if (action.kind === "fill") {
      if (!(await this.browser.fresh(page))) throw new StalePage("Page changed before text generation. Choose again.");
      const context = fieldContext(state.goal, action, page, state.history);
      const key = JSON.stringify(context);
      if (decision.replayed && this.exact && decision.step.text != null) {
        text = decision.step.text; // same goal, same day: same value
      } else if (this.pendingText?.key === key) {
        ({ text, helper } = this.pendingText);
      } else {
        let result;
        try {
          result = await fieldText(context, this.settings);
        } catch (error) {
          if (!(error instanceof NoFieldValue)) throw error;
          // The goal gives no (new) value for this field, e.g. Google already filled in your city.
          // Skip the field and choose again rather than ending the run.
          this.ineffective.add(actionKey(action));
          if (decision.replayed) this.pointer++;
          throw new StalePage(`No value to type into "${action.label}"`);
        }
        text = result.value;
        helper = result.helper;
        this.pendingText = { key, text, helper };
        state.text_calls.push({ ...helper, field: action.label, value: text });
      }
    }
    const reason = seriousReason(action, page);
    if (reason && !this.approved.has(actionKey(action))) {
      state.status = "approval";
      state.approval = { action: action.label, kind: action.kind, text, reason, url: page.url };
      this.onUpdate(state);
      const ok = await this.approve(state.approval);
      state.approval = null;
      if (!ok || this.stopped) {
        state.declined = action.label;
        this.stopped = true;
        state.status = "ready";
        return;
      }
      this.approved.add(actionKey(action));
    }
    // act() checks freshness immediately before input, including after text generation and approval.
    await this.browser.act(action, page, text);
    this.lastDecision = null; // executed: never replay it
    this.pendingText = null;
    // Advance through the learned steps: a replayed step, or the model doing the equivalent value step.
    const next = this.recipe?.steps[this.pointer];
    // A structural step the model skipped stays next; only a value step (other city, other date) is "done by the model".
    const equivalent = next && next.kind === action.kind && next.role === (action.role ?? null) &&
      (sameStep(next, action) || !structural(next, this.recipe));
    if (next && (decision.replayed || equivalent)) this.pointer++;
    state.elapsed_ms = this.elapsed();
    // Record execution before observing. A stale post-action observation must not erase the action.
    state.history.push({
      step: state.history.length + 1,
      action: action.label,
      kind: action.kind,
      role: action.role ?? null,
      replayed: decision.replayed ?? false,
      choice: selected,
      probability: decision.probabilities[selected],
      confidence: decision.confidence,
      latency_ms: decision.latency_ms,
      text,
      text_helper: helper?.model ?? null,
      text_latency_ms: helper?.latency_ms ?? 0,
      operation: decision.operation,
      target: decision.target,
      page_changed: null,
      url: page.url,
      elapsed_ms: state.elapsed_ms,
    });
    this.onUpdate(state);
    state.page = await this.browser.observe();
    state.elapsed_ms = this.elapsed();
    const last = state.history[state.history.length - 1];
    last.page_changed = state.page.fingerprint !== page.fingerprint;
    last.url = state.page.url;
    if (last.page_changed) this.ineffective.clear();
    else if (action.kind !== "wait") this.ineffective.add(actionKey(action));
    const repeated = state.history.slice(-3);
    state.status =
      repeated.length === 3 && repeated.every((h) => h.page_changed === false && h.kind !== "wait") ? "blocked" : "ready";
  }

  async run() {
    const state = this.state;
    state.started_at = performance.now();
    try {
      state.page = await this.browser.observe();
      state.start_url = state.page.url;
      this.onUpdate(state);
      while (!["done", "blocked"].includes(state.status)) {
        if (this.stopped) {
          state.status = "stopped";
          break;
        }
        await this.tick();
        this.onUpdate(state);
      }
    } catch (error) {
      state.status = "error";
      state.error = error.message;
    } finally {
      state.elapsed_ms = this.elapsed();
      this.onUpdate(state);
    }
    return state;
  }

  stop() {
    this.stopped = true;
  }
}
