// Offline tests for the extension's policy port: node --test tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  actionSpace, buildRequest, fieldContext, interpret, parseFieldText, postJson, validateChoice,
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

test("postJson retries overload, fails closed on errors", async () => {
  let calls = 0;
  const flaky = async () => (++calls < 2 ? { status: 503, ok: false } : { status: 200, ok: true, json: async () => ({ ok: 1 }) });
  assert.deepEqual(await postJson("u", "k", {}, flaky), { ok: 1 });
  assert.equal(calls, 2);
  await assert.rejects(postJson("u", "k", {}, async () => ({ status: 401, ok: false })), /HTTP 401; no action/);
  await assert.rejects(postJson("u", "k", {}, async () => { throw new TypeError("net"); }), /connection failed/);
});
