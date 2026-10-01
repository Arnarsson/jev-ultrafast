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
  if (!stored.typesafeKey || !stored.textKey) $("settings").open = true;
  return stored;
}

async function saveSettings() {
  const values = Object.fromEntries(FIELDS.map((f) => [f, $(f).value.trim()]));
  await chrome.storage.local.set(values);
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
  $("tab").textContent = tab ? `In this tab: ${tab.title || tab.url}` : "";
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

function render(state) {
  const steps = $("steps");
  steps.replaceChildren(
    ...state.history.map((h) => {
      const li = document.createElement("li");
      const t = Object.assign(document.createElement("span"), { className: "t", textContent: seconds(h.elapsed_ms) });
      const body = document.createElement("span");
      body.append(Object.assign(document.createElement("span"), { className: "op", textContent: h.operation }));
      body.append(h.action);
      if (h.text) body.append(" ", Object.assign(document.createElement("span"), { className: "typed", textContent: `“${h.text}”` }));
      li.append(t, body);
      return li;
    }),
  );
  if (state.status === "predicted" || state.status === "ready") {
    const li = document.createElement("li");
    li.append(
      Object.assign(document.createElement("span"), { className: "t", textContent: seconds(state.elapsed_ms) }),
      Object.assign(document.createElement("span"), { className: "thinking", textContent: "choosing…" }),
    );
    steps.append(li);
  }
  steps.lastElementChild?.scrollIntoView({ block: "nearest" });
}

function finish(state) {
  const result = $("result");
  const titles = { done: "Done", blocked: "Blocked — no supported action can progress", stopped: "Stopped", error: "Error" };
  result.dataset.status = state.status;
  result.replaceChildren(
    Object.assign(document.createElement("strong"), {
      textContent: `${titles[state.status] ?? state.status} · ${seconds(state.elapsed_ms)} · ${state.history.length} actions`,
    }),
    document.createTextNode(state.error ?? readableUrl(state.page?.url)),
  );
  if (state.status === "done") {
    result.append(Object.assign(document.createElement("p"), {
      className: "muted", textContent: "DONE is the agent's judgement. Check the page.",
    }));
  }
  result.hidden = false;
  setStatus(state.status);
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
  $("result").hidden = true;
  $("steps").replaceChildren();
  $("run").disabled = true;
  $("stop").hidden = false;
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
    $("run").disabled = false;
    $("stop").hidden = true;
    showTab();
  }
}

$("shortcut").textContent = IS_MAC ? "⌘↵" : "Ctrl↵";
$("task").addEventListener("submit", run);
$("goal").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(e);
});
$("stop").addEventListener("click", () => agent?.stop());
$("save").addEventListener("click", saveSettings);
chrome.tabs.onActivated.addListener(() => !agent && showTab());
chrome.tabs.onUpdated.addListener((_id, info) => info.title && !agent && showTab());

loadSettings();
showTab();
