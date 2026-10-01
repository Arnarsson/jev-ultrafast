import { Agent } from "./agent.js";
import { Browser } from "./browser.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["typesafeKey", "textKey", "textModel", "typesafeModel"];
const LABELS = { idle: "Idle", running: "Running", done: "Done", blocked: "Blocked", stopped: "Stopped", error: "Error" };
const IS_MAC = /Mac/.test(navigator.platform);
// ?tab=<id> lets the panel be opened as a normal page and aimed at another tab (used for testing).
const FIXED_TAB = Number(new URLSearchParams(location.search).get("tab")) || null;

const START_URL = "https://www.google.com/?hl=en";

let agent = null;

const hasKeys = () => Boolean($("typesafeKey").value.trim() && $("textKey").value.trim());
function updateKeyState() {
  const ok = hasKeys();
  $("keyState").dataset.ok = String(ok);
  $("keyState").textContent = ok ? "Keys saved ✓" : "Keys needed";
}

async function loadSettings() {
  let stored = await chrome.storage.local.get([...FIELDS, "goal"]);
  if (!stored.typesafeKey) {
    // Optional, git-ignored seed file so a local install needs no pasting.
    const seed = await fetch(chrome.runtime.getURL("config.local.json")).then((r) => r.json()).catch(() => null);
    if (seed) {
      await chrome.storage.local.set(seed);
      stored = { ...stored, ...seed };
    }
  }
  for (const field of FIELDS) $(field).value = stored[field] ?? "";
  if (stored.goal) $("goal").value = stored.goal;
  updateKeyState();
  $("settings").open = !hasKeys();
  return stored;
}

async function saveSettings() {
  const values = Object.fromEntries(FIELDS.map((f) => [f, $(f).value.trim()]));
  await chrome.storage.local.set(values);
  updateKeyState();
  if (hasKeys()) $("settings").open = false;
  $("saved").hidden = false;
  setTimeout(() => ($("saved").hidden = true), 1500);
}

async function targetTab() {
  if (FIXED_TAB) return chrome.tabs.get(FIXED_TAB);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function openTab(url, windowId) {
  const tab = await chrome.tabs.create({ url, windowId, active: true });
  await new Promise((resolve) => {
    const done = (id, info) => {
      if (id !== tab.id || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(done);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => (chrome.tabs.onUpdated.removeListener(done), resolve()), 10000);
  });
  return chrome.tabs.get(tab.id);
}

async function showTab() {
  const tab = await targetTab().catch(() => null);
  const label = tab ? tab.title || tab.url : "";
  $("tab").textContent = label ? `Acts on: ${label}` : "";
  $("tab").title = label;
}

function setStatus(status) {
  $("status").dataset.status = status;
  $("status").textContent = LABELS[status] ?? status;
}

const readableUrl = (url = "") => {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
};
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// --- live timer -----------------------------------------------------------
let timerStart = 0;
let timerId = null;
function startTimer() {
  timerStart = performance.now();
  $("timer").textContent = "0.0";
  clearInterval(timerId);
  timerId = setInterval(() => ($("timer").textContent = ((performance.now() - timerStart) / 1000).toFixed(1)), 100);
}
function stopTimer() {
  clearInterval(timerId);
  timerId = null;
}

function showStart(show) {
  $("start").hidden = !show;
}

// --- start screen: examples + recent goals ----------------------------------
const EXAMPLES = [
  "Find one-way flights from Copenhagen to Reykjavik on November 5",
  "Search Google for the weather in Copenhagen tomorrow",
  "Open the Wikipedia page for Reykjavik and show its population",
  "Find a 2-person table for Friday 19:00 at a restaurant in Copenhagen",
];
function useGoal(goal, andRun = false) {
  $("goal").value = goal;
  if (andRun) return run();
  $("goal").focus();
}
async function renderStart() {
  const chips = $("chips");
  chips.replaceChildren(
    ...EXAMPLES.map((g) => {
      const b = el("button", "chip", g);
      b.type = "button";
      b.addEventListener("click", () => useGoal(g));
      return b;
    }),
  );
  const { recent = [] } = await chrome.storage.local.get("recent");
  $("recentWrap").hidden = !recent.length;
  $("recent").replaceChildren(
    ...recent.map((g) => {
      const li = el("li");
      const b = el("button", null, g);
      b.type = "button";
      b.title = `Run again: ${g}`;
      b.addEventListener("click", () => useGoal(g, true));
      li.append(b);
      return li;
    }),
  );
}
async function rememberGoal(goal) {
  const { recent = [] } = await chrome.storage.local.get("recent");
  await chrome.storage.local.set({ recent: [goal, ...recent.filter((g) => g !== goal)].slice(0, 5) });
}

// --- steps ---------------------------------------------------------------------
function render(state) {
  const steps = $("steps");
  const count = state.history.length;
  $("count").textContent = plural(count, "action");
  $("phase").textContent = state.status === "predicted" || state.status === "ready" ? "choosing next action…" : "acting…";
  const stepNode = (h) => {
    const li = el("li");
    const body = el("span", "target");
    body.append(el("span", "op", h.operation));
    body.append(h.action);
    if (h.text) body.append(" ", el("span", "typed", `“${h.text}”`));
    if (h.page_changed === false) {
      const m = el("span", "nochange", "no change");
      m.title = "The page looked the same after this action";
      body.append(m);
    }
    li.append(el("span", "t", seconds(h.elapsed_ms)), body);
    return li;
  };
  // Reuse existing rows so streaming only animates the new step.
  const rows = [...steps.children].filter((n) => !n.classList.contains("pending"));
  steps.querySelector(".pending")?.remove();
  state.history.forEach((h, i) => {
    if (!rows[i]) steps.append(stepNode(h));
    else rows[i].replaceWith(Object.assign(stepNode(h), { style: "animation:none" }));
  });
  while (steps.children.length > count) steps.lastElementChild.remove();
  if (state.status === "predicted" || state.status === "ready") {
    const li = el("li", "pending");
    li.append(el("span", "t", seconds(state.elapsed_ms)), el("span", "thinking", "choosing…"));
    steps.append(li);
  }
  steps.lastElementChild?.scrollIntoView({ block: "nearest" });
}

// --- result ----------------------------------------------------------------------
const OUTCOMES = {
  done: "Done",
  blocked: "Blocked",
  stopped: "Stopped",
  error: "Something went wrong",
};
const EXPLAIN = {
  blocked: "Jev couldn't find an action that moves this forward. The page may need a login, a captcha, or something Jev can't operate yet. Look at the tab, take over where it stopped, or rephrase the goal.",
  stopped: "You stopped the run. The tab is left exactly where Jev got to.",
  done: "Done is Jev's own judgement. Check the page before you rely on it.",
};
function friendlyError(message = "") {
  if (/401|403|api key|unauthor/i.test(message)) return "A model rejected the API key. Check Settings below.";
  if (/network|failed to fetch|timeout|ECONN/i.test(message)) return "Couldn't reach the model service. Check your connection and run again.";
  if (/debugger|attach|cannot access|another debugger/i.test(message)) return "Jev couldn't take control of this tab. Close DevTools on it, or switch to a normal web page.";
  return "The run stopped with an error.";
}
function hostOf(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function finish(state) {
  stopTimer();
  $("live").hidden = true;
  const result = $("result");
  const status = state.status === "predicted" || state.status === "ready" ? "stopped" : state.status;
  result.dataset.status = status;
  const head = el("div", "head");
  head.append(
    el("span", "outcome", OUTCOMES[status] ?? status),
    el("span", "stats", `${seconds(state.elapsed_ms)} · ${plural(state.history.length, "action")}`),
  );
  result.replaceChildren(head);
  if (status !== "error" && state.page?.url) {
    result.append(el("p", "page", state.page.title || hostOf(state.page.url)));
    result.append(el("p", "url", readableUrl(state.page.url)));
  }
  const note = status === "error" ? friendlyError(state.error) : EXPLAIN[status];
  if (note) result.append(el("p", "note", note));
  if (status === "error" && state.error) {
    const d = el("details", "raw");
    d.append(el("summary", null, "Details"), el("pre", null, state.error));
    result.append(d);
  }
  const actions = el("div", "actions");
  const again = el("button", "secondary", "Run again");
  again.type = "button";
  again.addEventListener("click", () => run());
  const edit = el("button", "secondary", "Edit goal");
  edit.type = "button";
  edit.addEventListener("click", () => ($("goal").focus(), $("goal").select()));
  actions.append(again, edit);
  result.append(actions);
  result.hidden = false;
  setStatus(status);
  showStart(false);
}

function setRunning(on) {
  $("run").disabled = on;
  $("goal").disabled = on;
  $("live").hidden = !on;
  if (on) {
    startTimer();
    $("count").textContent = "0 actions";
    $("phase").textContent = "starting…";
    $("stop").disabled = false;
  }
}

async function run(event) {
  event?.preventDefault();
  if (agent) return;
  const goal = $("goal").value.trim();
  if (!goal) return;
  const settings = await chrome.storage.local.get(FIELDS);
  if (!settings.typesafeKey) {
    $("settings").open = true;
    $("typesafeKey").focus();
    return;
  }
  await chrome.storage.local.set({ goal });
  rememberGoal(goal);
  $("result").hidden = true;
  $("steps").replaceChildren();
  showStart(false);
  setRunning(true);
  setStatus("running");
  let browser = null;
  try {
    let tab = await targetTab();
    // Chrome pages (chrome://, new tab, Web Store) can't be controlled; start from Google in a fresh tab instead.
    if (!tab || !/^https?:/.test(tab.url || "")) tab = await openTab(START_URL, tab?.windowId);
    browser = await Browser.attach(tab.id);
    agent = new Agent(browser, goal, settings, render);
    const state = await agent.run();
    window.lastRun = state; // inspectable from DevTools
    render(state);
    finish(state);
  } catch (error) {
    finish({ status: "error", error: error.message, history: [], elapsed_ms: 0 });
  } finally {
    await browser?.detach();
    agent = null;
    stopTimer();
    setRunning(false);
    renderStart();
    showTab();
  }
}

$("shortcut").textContent = IS_MAC ? "⌘↵" : "Ctrl↵";
$("task").addEventListener("submit", run);
$("goal").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(e);
});
$("stop").addEventListener("click", () => {
  $("stop").disabled = true;
  $("phase").textContent = "stopping…";
  agent?.stop();
});
$("save").addEventListener("click", saveSettings);
chrome.tabs.onActivated.addListener(() => !agent && showTab());
chrome.tabs.onUpdated.addListener((_id, info) => info.title && !agent && showTab());

// Test hook: lets the panel be rendered with fake state without running an agent.
window.__panel = { render, finish, setRunning, setStatus, showStart, renderStart };

loadSettings();
renderStart();
showTab();
