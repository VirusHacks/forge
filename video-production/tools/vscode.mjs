// Drives the real VS Code renderer over CDP: input events, element lookup (incl. webviews),
// and frame capture. All effects happen in the real editor; nothing is simulated.
import { connect } from "./cdp.mjs";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

export const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEYS = {
  Enter: [13, "Enter"], Escape: [27, "Escape"], Tab: [9, "Tab"], Backspace: [8, "Backspace"], Delete: [46, "Delete"],
  ArrowDown: [40, "ArrowDown"], ArrowUp: [38, "ArrowUp"], ArrowLeft: [37, "ArrowLeft"], ArrowRight: [39, "ArrowRight"],
  Home: [36, "Home"], End: [35, "End"], PageDown: [34, "PageDown"], PageUp: [33, "PageUp"], Space: [32, "Space"],
  Backquote: [192, "Backquote"], Period: [190, "Period"], Comma: [188, "Comma"], Slash: [191, "Slash"],
};
const MOD = { alt: 1, ctrl: 2, cmd: 4, meta: 4, shift: 8 };

export async function open({ width = 1440, height = 810, scale = 4 / 3, emulate = false, attach = false } = {}) {
  const c = await connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  if (emulate) {
    await c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  }
  // Webviews may be out-of-process iframes: attach so we can query/click inside them.
  const frames = new Map(); // sessionId -> url
  c.on("Target.attachedToTarget", p => { if (p.targetInfo.type === "iframe") frames.set(p.sessionId, p.targetInfo.url); });
  if (attach) await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const api = {
    c,
    async eval(expr) {
      const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async key(combo, { delay = 40 } = {}) {
      const parts = combo.split("+"); const name = parts.pop();
      const modifiers = parts.reduce((m, p) => m | MOD[p.toLowerCase()], 0);
      let code, keyCode, key;
      if (KEYS[name]) { [keyCode, code] = KEYS[name]; key = name === "Space" ? " " : name === "Backquote" ? "`" : name === "Period" ? "." : name; }
      else if (/^[a-z]$/i.test(name)) { key = name.toLowerCase(); code = "Key" + name.toUpperCase(); keyCode = name.toUpperCase().charCodeAt(0); }
      else if (/^[0-9]$/.test(name)) { key = name; code = "Digit" + name; keyCode = name.charCodeAt(0); }
      else if (/^F\d+$/.test(name)) { key = name; code = name; keyCode = 111 + Number(name.slice(1)); }
      const base = { modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      if (!modifiers && key.length === 1) await c.send("Input.dispatchKeyEvent", { type: "char", ...base, text: key });
      await sleep(delay);
      await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(delay);
    },
    async type(text, { cps = 28, jitter = 0.5 } = {}) {
      for (const ch of text) {
        if (ch === "\n") { await api.key("Enter"); continue; }
        await c.send("Input.insertText", { text: ch });
        await sleep((1000 / cps) * (1 - jitter / 2 + Math.random() * jitter));
      }
    },
    async paste(text) { await c.send("Input.insertText", { text }); },
    async mouse(x, y, { click = true, steps = 14, from } = {}) {
      const start = from ?? api.cursor ?? { x: x - 200, y: y + 120 };
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const px = start.x + (x - start.x) * e, py = start.y + (y - start.y) * e;
        await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
        api.log?.({ ev: "cursor", x: px, y: py });
        await sleep(16);
      }
      api.cursor = { x, y };
      if (!click) return;
      api.log?.({ ev: "click", x, y });
      api.capturePaused = true; await (api.captureIdle?.() ?? Promise.resolve()); await sleep(40);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await sleep(70);
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await sleep(150); api.capturePaused = false;
      await sleep(120);
    },
    /** Bounding box (CSS px, top-level coordinates) of an element in the workbench. */
    async box(selector, text) {
      return api.eval(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter(e => ${text ? `(e.textContent||e.getAttribute('aria-label')||'').includes(${JSON.stringify(text)})` : "true"});
        const e = els.find(e => e.getBoundingClientRect().width > 0); if (!e) return null; const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, l: r.x, t: r.y }; })()`);
    },
    async click(selector, text) { const b = await api.box(selector, text); if (!b) throw new Error(`not found: ${selector} ${text ?? ""}`); await api.mouse(b.x, b.y); return b; },
    /** Evaluate inside the Forge webview content frame. */
    async webEval(expr) {
      const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
      api.webs ??= new Map();
      for (const t of list.filter(t => t.type === "iframe" && t.url.startsWith("vscode-webview"))) {
        let w = api.webs.get(t.id);
        if (!w) {
          const ws = new WebSocket(t.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(rej, 3000); }).catch(() => undefined);
          if (ws.readyState !== 1) continue;
          w = { ws, id: 0, pending: new Map() };
          w.send = (method, params = {}) => new Promise(res => { const i = ++w.id; w.pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => res({ error: "timeout" }), 5000); });
          ws.onmessage = ev => { const m = JSON.parse(ev.data); const p = w.pending.get(m.id); if (p) { w.pending.delete(m.id); p(m); } };
          const tree = await w.send("Page.getFrameTree");
          const kids = tree?.result?.frameTree?.childFrames ?? [];
          const inner = kids.find(k => k.frame.name === "active-frame" || /fake\.html|index-no-csp|id=/.test(k.frame.url)) ?? kids[0];
          if (!inner) { ws.close(); continue; }
          const world = await w.send("Page.createIsolatedWorld", { frameId: inner.frame.id, worldName: "forge-recorder", grantUniveralAccess: false });
          w.ctx = world?.result?.executionContextId;
          // Offset of the inner frame inside the webview host document.
          const off = await w.send("Runtime.evaluate", { expression: `(() => { const f = document.getElementById("active-frame") || document.querySelector("iframe"); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y }; })()`, returnByValue: true });
          w.off = off?.result?.result?.value ?? { x: 0, y: 0 };
          api.webs.set(t.id, w);
        }
        if (!w.ctx) continue;
        const m = await w.send("Runtime.evaluate", { expression: `(() => { window.__off = ${JSON.stringify(w.off)}; if (!document.getElementById("app")) return "__none__"; return (${expr}); })()`, contextId: w.ctx, returnByValue: true });
        const value = m?.result?.result?.value;
        if (process.env.DBG) console.log(JSON.stringify(m).slice(0, 400));
        if (value !== undefined && value !== "__none__") return value;
      }
      return "__none__";
    },
    /** Box of an element inside the webview, translated to top-level coordinates. */
    async webBox(selector, text) {
      const inner = await api.webEval(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => ${text ? `(e.textContent||e.title||'').includes(${JSON.stringify(text)})` : "true"}); const e = els.find(e => e.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({block: "nearest"}); const r = e.getBoundingClientRect(); return { x: r.x + r.width/2 + window.__off.x, y: r.y + r.height/2 + window.__off.y, w: r.width, h: r.height }; })()`);
      if (!inner || inner === "__none__") return null;
      const host = await api.eval(`(() => { const fs = [...document.querySelectorAll("iframe")].filter(f => f.getBoundingClientRect().width > 0 && f.closest(".part.sidebar, .part.auxiliarybar, .webview")); const all = fs.length ? fs : [...document.querySelectorAll("iframe")].filter(f => f.getBoundingClientRect().width > 0); const r = all[0]?.getBoundingClientRect(); return r ? { l: r.x, t: r.y } : null; })()`);
      return { x: host.l + inner.x, y: host.t + inner.y, w: inner.w, h: inner.h };
    },
    /** Click in the webview until check() is true (the sidebar re-renders while a run is live). */
    async webClickUntil(selector, text, check, { tries = 4, wait = 3000 } = {}) {
      for (let i = 0; i < tries; i++) {
        await api.webClick(selector, text).catch(() => undefined);
        const t0 = Date.now();
        while (Date.now() - t0 < wait) { if (await check()) return true; await sleep(120); }
      }
      throw new Error(`click had no effect: ${selector} ${text ?? ""}`);
    },
    async webClick(selector, text) { const b = await api.webBox(selector, text); if (!b) throw new Error(`webview element not found: ${selector} ${text ?? ""}`); await api.mouse(b.x, b.y); return b; },
    async shot(file) { const s = await c.send("Page.captureScreenshot", { format: "png" }); writeFileSync(file, Buffer.from(s.data, "base64")); },
    async waitFor(fn, { timeout = 600000, every = 300, label = "condition" } = {}) {
      const t0 = Date.now();
      for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${label}`); await sleep(every); }
    },
  };
  return api;
}

/** Continuous frame capture to <dir>/frames/*.jpg with an index of capture timestamps. */
export function recorder(api, dir, { fps = 24 } = {}) {
  const framesDir = path.join(dir, "frames"); mkdirSync(framesDir, { recursive: true });
  const index = path.join(dir, "frames.tsv"), events = path.join(dir, "events.jsonl");
  writeFileSync(index, ""); writeFileSync(events, "");
  let running = true, n = 0; const t0 = Date.now();
  api.log = e => appendFileSync(events, JSON.stringify({ t: (Date.now() - t0) / 1000, ...e }) + "\n");
  let busy = Promise.resolve();
  api.captureIdle = () => busy;
  const loop = (async () => {
    while (running) {
      if (api.capturePaused) { await sleep(20); continue; }
      let done; busy = new Promise(r => (done = r));
      const started = Date.now();
      try {
        const s = await api.c.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
        const name = String(n++).padStart(6, "0") + ".jpg";
        writeFileSync(path.join(framesDir, name), Buffer.from(s.data, "base64"));
        appendFileSync(index, `${name}\t${(started - t0) / 1000}\n`);
      } catch (e) { appendFileSync(events, JSON.stringify({ t: (Date.now() - t0) / 1000, ev: "capture-error", message: String(e.message) }) + "\n"); }
      done();
      const spent = Date.now() - started; if (spent < 1000 / fps) await sleep(1000 / fps - spent);
    }
  })();
  return {
    mark(label, extra = {}) { api.log({ ev: "mark", label, ...extra }); console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`); },
    elapsed: () => (Date.now() - t0) / 1000,
    async stop() { running = false; await loop; return n; },
  };
}
