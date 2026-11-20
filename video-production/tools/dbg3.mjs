const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const t = list.find(x => x.type === "iframe");
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
ws.onmessage = e => { console.log(String(e.data).slice(0, 600)); process.exit(0); };
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { returnByValue: true, expression: `JSON.stringify({ url: location.href.slice(0,60), app: !!document.getElementById("app"), iframes: [...document.querySelectorAll("iframe")].map(f => { let ok; try { ok = !!f.contentDocument?.getElementById("app"); } catch(e) { ok = String(e).slice(0,40); } return [f.id, ok]; }) })` } }));
setTimeout(() => { console.log("no reply"); process.exit(1); }, 5000);
