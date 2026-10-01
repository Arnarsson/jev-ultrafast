// Offline tests for the extension's policy port: node --test tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  actionSpace, buildRequest, fieldContext, interpret, parseFieldText, postJson, today, validateChoice,
} from "../extension/policy.js";

const actions = [
  { id: "e1", kind: "fill", node: 1, role: "combobox", label: "Where from?", value: "" },
  { id: "e2", kind: "click", node: 1, role: "combobox", label: "Open Where from?", value: "" },
  { id: "e3", kind: "click", node: 2, role: "button", label: "Search", value: "" },
  { id: "e4", kind: "select", node: 3, role: "combobox", label: "Class → Business", value: "b", current_value: "Economy" },
  { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
  { id: "wait", kind: "wait", label: "Wait for the page to update" },
];
const page = { url: "https://x.test/", title: "X", text: "Flights", actions };

test("snapshot.js is identical to the Python package copy", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  assert.equal(read("../extension/snapshot.js"), read("../jev_ultrafast/snapshot.js"));
});

test("actionSpace indexes elements once and groups operation targets", () => {
  const { elements, targets, controls } = actionSpace(actions);
  assert.deepEqual(elements.map((e) => [e.index, e.label, e.operations]), [
    ["1", "Where from?", ["TYPE_TEXT", "CLICK"]],
    ["2", "Search", ["CLICK"]],
    ["3", "Class", ["SELECT"]],
  ]);
  assert.deepEqual(Object.keys(targets.CLICK), ["1", "2"]);
  assert.deepEqual(Object.keys(targets.SELECT), ["3:1"]);
  assert.equal(elements[2].value, "Economy");
  assert.deepEqual(Object.keys(controls), ["SCROLL_DOWN", "WAIT"]);
});

test("buildRequest offers only supported operations and per-operation target heads", () => {
  const { body } = buildRequest(page, "goal", [], "jev-latest");
  assert.deepEqual(Object.keys(body.questions).sort(), ["click_target", "operation", "select_target", "type_text_target"]);
  assert.deepEqual(Object.keys(body.questions.operation.criteria).sort(),
    ["BLOCKED", "CLICK", "DONE", "SCROLL_DOWN", "SELECT", "TYPE_TEXT", "WAIT"]);
  assert.equal(body.questions.click_target.criteria["2"].element, "[2] Search");
});

const answer = (choice, ids) => ({
  type: "choice", choice, confidence: 0.9,
  probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
});

test("interpret consumes only the selected operation's target head", () => {
  const request = buildRequest(page, "goal", [], "jev-latest");
  const ops = Object.keys(request.operations);
  const result = {
    model: "jev", answers: {
      operation: answer("CLICK", ops),
      click_target: answer("2", ["1", "2"]),
      type_text_target: { garbage: true },
    },
  };
  const decision = interpret(result, request);
  assert.equal(decision.choice, "e3");
  assert.equal(decision.target, "2");
  const done = interpret({ model: "jev", answers: { operation: answer("DONE", ops) } }, request);
  assert.equal(done.choice, "DONE");
  const wait = interpret({ model: "jev", answers: { operation: answer("WAIT", ops) } }, request);
  assert.equal(wait.choice, "wait");
});

test("validateChoice rejects unknown choices and bad distributions", () => {
  const ids = { A: 1, B: 1 };
  assert.throws(() => validateChoice({ choice: "C", confidence: 1, probabilities: { A: 0.5, B: 0.5 } }, ids));
  assert.throws(() => validateChoice({ choice: "A", confidence: 1, probabilities: { A: 0.9, B: 0.3 } }, ids));
  assert.throws(() => validateChoice({ choice: "B", confidence: 1, probabilities: { A: 0.7, B: 0.3 } }, ids));
  assert.throws(() => validateChoice({ choice: "A", confidence: 2, probabilities: { A: 1, B: 0 } }, ids));
  assert.equal(validateChoice({ choice: "A", confidence: 0.5, probabilities: { A: 0.6, B: 0.4 } }, ids).choice, "A");
});

test("parseFieldText accepts only {text: non-empty string}", () => {
  assert.equal(parseFieldText('{"text":"Zurich"}'), "Zurich");
  for (const bad of ['{"text":null}', '{"text":""}', '{"text":"a","x":1}', "not json", undefined]) {
    assert.throws(() => parseFieldText(bad), /nothing typed/);
  }
});

test("fieldContext trims page text and history", () => {
  const history = Array.from({ length: 9 }, (_, i) => ({ action: `a${i}`, text: null, extra: 1 }));
  const context = fieldContext("g", actions[0], { title: "T", text: "x".repeat(9000) }, history);
  assert.equal(context.page.text.length, 6000);
  assert.equal(context.recent_actions.length, 6);
  assert.deepEqual(Object.keys(context.recent_actions[0]), ["action", "text"]);
});

test("the models are told today's date", () => {
  assert.equal(today(new Date(2026, 9, 1)), "Thursday, October 1, 2026");
  const { body } = buildRequest(page, "goal", [], "jev-latest", "D");
  for (const q of Object.values(body.questions)) assert.equal(q.instructions.today, "D");
  assert.equal(fieldContext("g", actions[0], { title: "T", text: "" }, [], "D").today, "D");
});

test("postJson retries overload, fails closed on errors", async () => {
  let calls = 0;
  const flaky = async () => (++calls < 2 ? { status: 503, ok: false } : { status: 200, ok: true, json: async () => ({ ok: 1 }) });
  assert.deepEqual(await postJson("u", "k", {}, flaky), { ok: 1 });
  assert.equal(calls, 2);
  await assert.rejects(postJson("u", "k", {}, async () => ({ status: 401, ok: false })), /HTTP 401; no action/);
  await assert.rejects(postJson("u", "k", {}, async () => { throw new TypeError("net"); }), /connection failed/);
});

test("a stale decision is reused once, only when its element remains and nothing new appeared", async () => {
  const { Agent } = await import("../extension/agent.js");
  const button = (node, label, id) => ({ id, node, kind: "click", label });
  const old = { url: "https://x.test/p", title: "t", actions: [button(1, "Search", "e1"), button(2, "Next", "e2")] };
  const decision = { choice: "e2", probabilities: { e2: 0.9 } };
  const agent = new Agent({}, "goal", {});
  const reuse = (page) => ((agent.retry = { decision, page: old }), agent.reuse(page));

  const settled = { ...old, actions: [button(2, "Next", "e1"), button(1, "Search", "e2")] };
  assert.deepEqual([reuse(settled).choice, reuse(settled).reused], ["e1", true]);
  assert.equal(agent.retry, null); // consumed
  assert.equal(reuse({ ...old, actions: [...old.actions, button(3, "Tokyo, Japan", "e3")] }), null);
  assert.equal(reuse({ ...old, actions: [button(1, "Search", "e1")] }), null);
  assert.equal(reuse({ ...old, url: "https://x.test/other" }), null);
  assert.equal(reuse({ ...settled, url: "https://x.test/p?tfs=x" }).choice, "e1"); // same page, rewritten query
  assert.equal(reuse({ ...old, actions: [button(1, "Search", "e1"), button(2, "Next, 9,356 kr", "e2")] }).choice, "e2");
  assert.equal(reuse({ ...old, actions: [button(1, "Search", "e1"), button(2, "Previous", "e2")] }), null);
  agent.ineffective.add("click|2|Next");
  assert.equal(reuse(settled), null);
});

test("recipes keep effective steps and replay only goal-independent ones on a new goal", async () => {
  const { recordRecipe, findRecipe, saveRecipe, structural, pageKey } = await import("../extension/recipes.js");
  const h = (kind, action, extra = {}) => ({ kind, action, role: "button", operation: "CLICK", page_changed: true, ...extra });
  const state = {
    goal: "Tokyo to Reykjavik", start_url: "https://www.google.com/travel/flights?hl=en",
    history: [
      h("fill", "Where from?", { role: "combobox", operation: "TYPE_TEXT", text: "Tokyo" }),
      h("click", "Tokyo, Japan"),
      h("click", "Open Return", { page_changed: false }),
      h("wait", "Wait"),
      h("click", "Thursday, October 1, 2026"),
      h("click", "Search"),
    ],
  };
  const recipe = recordRecipe(state, "D1");
  assert.equal(recipe.key, "https://www.google.com/travel/flights");
  assert.deepEqual(recipe.steps.map((s) => s.label), ["Where from?", "Tokyo, Japan", "Thursday, October 1, 2026", "Search"]);
  assert.deepEqual(recipe.steps.map((s) => structural(s, recipe)), [true, false, false, true]);
  const saved = saveRecipe(saveRecipe([], recipe), { ...recipe, saved_at: 2 });
  assert.equal(saved.length, 1);
  assert.equal(findRecipe(saved, "https://www.google.com/travel/flights?x=1", "Tokyo to Reykjavik", "D1").exact, true);
  assert.equal(findRecipe(saved, "https://www.google.com/travel/flights", "Tokyo to Reykjavik", "D2").exact, false);
  assert.equal(findRecipe(saved, "https://example.com/", "x", "D1"), null);
  assert.equal(pageKey("not a url"), "not a url");
  const { sameLabel } = await import("../extension/recipes.js");
  assert.ok(sameLabel("Thursday, October 1, 2026 ????", "Thursday, October 1, 2026 , 16380 Danish kroner"));
  assert.ok(!sameLabel("Thursday, October 1, 2026", "Thursday, October 15, 2026"));
  assert.ok(!sameLabel("Add", "Remove"));
  assert.ok(!sameLabel("Page 1", "Page 10"));
  assert.ok(sameLabel("Search", "Search"));
});

test("serious actions are recognised; ordinary browsing is not", async () => {
  const { seriousReason } = await import("../extension/guard.js");
  const page = { url: "https://shop.test/product/1" };
  const click = (label, role = "button") => seriousReason({ kind: "click", role, label }, page);
  for (const label of ["Buy now", "Place your order", "Pay €12", "Book", "Confirm booking", "Send", "Delete account", "Subscribe"])
    assert.ok(click(label), label);
  for (const label of ["Search", "Accept all", "Next", "Thursday, October 1, 2026", "Open Departure", "Bookmarks", "Payload docs"])
    assert.equal(click(label), null, label);
  assert.ok(seriousReason({ kind: "fill", label: "Card number" }, page));
  assert.equal(seriousReason({ kind: "fill", label: "Where from?" }, page), null);
  assert.ok(seriousReason({ kind: "click", role: "button", label: "Continue" }, { url: "https://shop.test/checkout/step2" }));
});

test("the agent refuses a serious action unless approved", async () => {
  const { Agent } = await import("../extension/agent.js");
  const page = { url: "https://shop.test/p", fingerprint: "f", actions: [{ id: "e1", node: 1, kind: "click", role: "button", label: "Buy now" }] };
  let acted = 0;
  const browser = { fresh: async () => true, act: async () => void acted++, observe: async () => page };
  for (const [answer, expected] of [[false, 0], [true, 1]]) {
    acted = 0;
    let asked = null;
    const agent = new Agent(browser, "buy it", {}, () => {}, { approve: async (r) => ((asked = r), answer) });
    agent.state.page = page;
    agent.state.decision = { choice: "e1", probabilities: {}, operation: "CLICK" };
    await agent.act();
    assert.equal(asked.action, "Buy now");
    assert.equal(acted, expected);
    assert.equal(agent.stopped, !answer);
  }
  const silent = new Agent(browser, "buy it", {});
  silent.state.page = page;
  silent.state.decision = { choice: "e1", probabilities: {}, operation: "CLICK" };
  acted = 0;
  await silent.act();
  assert.equal(acted, 0); // no approver: refused
});
