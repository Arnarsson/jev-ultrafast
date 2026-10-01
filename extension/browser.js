// Observed actions in the user's current tab through chrome.debugger. Port of jev_ultrafast/browser.py.

export class StalePage extends Error {}

const IS_MAC = /Mac/.test(navigator.platform);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const AFTER_INPUT = `(action => new Promise(resolve => {
  const field=window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
      .split(/\\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))`;

// Code-owned node IDs refer to actual observed elements, never model-generated selectors.
const RESOLVE_TARGET = `(action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  if (!e.contains(document.elementFromPoint(x,y))) return null;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
})`;

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Browser {
  constructor(tabId, snapshotSource) {
    this.target = { tabId };
    this.readState = snapshotSource.trim();
    this.marker = `(() => { const state=${this.readState}; return state?.marker ?? null; })()`;
    this.afterInput = null;
  }

  static async attach(tabId) {
    const source = await (await fetch(chrome.runtime.getURL("snapshot.js"))).text();
    const browser = new Browser(tabId, source);
    try {
      await chrome.debugger.attach(browser.target, "1.3");
    } catch (error) {
      throw new Error(`Cannot control this tab (${error.message}). Chrome pages and the Web Store are off limits.`);
    }
    // The side panel takes keyboard focus; keep the page rendering and behaving as focused.
    await browser.call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    return browser;
  }

  call(method, params = {}) {
    return chrome.debugger.sendCommand(this.target, method, params);
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    let response;
    try {
      response = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    } catch {
      throw new StalePage("Document changed during evaluation");
    }
    if (response.exceptionDetails) throw new StalePage("Document changed during evaluation");
    return response.result?.value;
  }

  async observe() {
    if (this.afterInput) {
      const action = this.afterInput;
      this.afterInput = null;
      // Read-only, after execution was logged, even if navigation interrupts it.
      await this.evaluate(`${AFTER_INPUT}(${JSON.stringify(action)})`, { awaitPromise: true }).catch(() => {});
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const info = await this.evaluate(this.readState);
        if (info == null) throw new StalePage("Document is navigating");
        const { url, text, actions, scroll } = info;
        info.fingerprint = await sha256(JSON.stringify({ actions, scroll, text, url }));
        return info;
      } catch (error) {
        if (!(error instanceof StalePage) || attempt === 9) throw error;
        await sleep(attempt < 5 ? 20 : 200);
      }
    }
    throw new StalePage("Page did not settle");
  }

  async fresh(page, action = null) {
    if (action && (action.kind === "click" || action.kind === "select")) {
      if (!Number.isInteger(action.node)) return false;
      const current = await this.evaluate(
        `(() => { const c=window.__jevFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${action.node}))] : null; })()`,
      );
      return JSON.stringify(current) === JSON.stringify([page.page_key, page.guards[String(action.node)] ?? null]);
    }
    return JSON.stringify(await this.evaluate(this.marker)) === JSON.stringify(page.marker);
  }

  async act(action, page, text = null) {
    if (!(await this.fresh(page, action))) throw new StalePage("Page changed since this decision. Observe again.");
    const kind = action.kind;
    if (kind === "wait") {
      await sleep(100);
    } else if (kind === "scroll") {
      await this.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 550, y: 400, deltaX: 0, deltaY: action.delta });
    } else {
      if (!Number.isInteger(action.node)) throw new Error("Invalid observed node");
      let target;
      try {
        const response = await this.call("Runtime.evaluate", {
          expression: `${RESOLVE_TARGET}(${JSON.stringify(action)})`,
          returnByValue: true,
        });
        if (response.exceptionDetails) throw new Error();
        target = response.result?.value;
      } catch {
        if (kind === "select") throw new Error("Dropdown execution was interrupted; inspect before retrying.");
        throw new StalePage("Document changed during evaluation");
      }
      if (target == null) {
        if (kind === "select") throw new Error("Dropdown execution was not confirmed; inspect before retrying.");
        throw new StalePage("Target changed or is covered. Observe again.");
      }
      if (kind !== "select") {
        const { x, y } = target;
        for (const type of ["mousePressed", "mouseReleased"]) {
          await this.call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
        }
        if (kind === "fill") {
          const modifiers = IS_MAC ? 4 : 2;
          await this.call("Input.dispatchKeyEvent", {
            type: "keyDown", key: "a", code: "KeyA", modifiers, commands: ["selectAll"],
          });
          await this.call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers });
          await this.call("Input.insertText", { text });
        }
      }
    }
    this.afterInput = kind !== "wait" ? action : null;
    return { executed: action.id };
  }

  async detach() {
    await chrome.debugger.detach(this.target).catch(() => {});
  }
}
