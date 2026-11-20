// Minimal Chrome DevTools Protocol client for the VS Code renderer (no dependencies).
export async function connect(port = 9333, match = "Extension Development Host") {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find(t => t.type === "page" && t.title.includes(match)) ?? list.find(t => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const listeners = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method) for (const fn of listeners.get(m.method) ?? []) fn(m.params);
  };
  const send = (method, params = {}, sessionId, timeoutMs = 20000) => new Promise((res, rej) => { const i = ++id; const timer = setTimeout(() => { pending.delete(i); rej(new Error(`CDP timeout: ${method}`)); }, timeoutMs); pending.set(i, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); };
  return { send, on, close: () => ws.close(), target };
}
