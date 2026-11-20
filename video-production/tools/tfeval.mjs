// Evaluate JS in the TrueForge page shown in VS Code's Simple Browser (view navigation only).
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const t = list.find(x => x.url.startsWith("http://localhost:8790"));
if (!t) { console.log("no trueforge target"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) { console.log(JSON.stringify(m.result?.result?.value ?? m).slice(0, 4000)); process.exit(0); } };
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: process.argv[2], returnByValue: true, awaitPromise: true } }));
setTimeout(() => { console.log("timeout"); process.exit(1); }, 8000);
