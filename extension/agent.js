// The complete agent loop. Port of jev_ultrafast/agent.py: typed choices, bounded execution.

import { StalePage } from "./browser.js";
import { MAX_STEPS, choose, fieldContext, fieldText } from "./policy.js";

export class Agent {
  constructor(browser, goal, settings, onUpdate = () => {}) {
    if (!goal.trim()) throw new Error("Supply a task");
    this.browser = browser;
    this.settings = settings;
    this.onUpdate = onUpdate;
    this.pendingText = null;
    this.stopped = false;
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
    if (state.decisions.length >= MAX_STEPS * 2) throw new Error("Reached the model-call budget");
    state.decision = await choose(state.page, state.goal, state.history, this.settings);
    state.decisions.push({ ...state.decision, fingerprint: state.page.fingerprint, elapsed_ms: this.elapsed() });
    state.status = "predicted";
    this.onUpdate(state);
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
      if (this.pendingText?.key === key) {
        ({ text, helper } = this.pendingText);
      } else {
        const result = await fieldText(context, this.settings);
        text = result.value;
        helper = result.helper;
        this.pendingText = { key, text, helper };
        state.text_calls.push({ ...helper, field: action.label, value: text });
      }
    }
    // act() checks freshness immediately before input, including after text generation.
    await this.browser.act(action, page, text);
    this.pendingText = null;
    state.elapsed_ms = this.elapsed();
    // Record execution before observing. A stale post-action observation must not erase the action.
    state.history.push({
      step: state.history.length + 1,
      action: action.label,
      kind: action.kind,
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
    const repeated = state.history.slice(-3);
    state.status =
      repeated.length === 3 && repeated.every((h) => h.page_changed === false && h.kind !== "wait") ? "blocked" : "ready";
  }

  async run() {
    const state = this.state;
    state.started_at = performance.now();
    try {
      state.page = await this.browser.observe();
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
