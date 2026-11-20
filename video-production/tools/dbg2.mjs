import { connect } from "./cdp.mjs";
const c = await connect();
const got = [];
c.on("Target.attachedToTarget", p => got.push(p));
await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await new Promise(r => setTimeout(r, 800));
for (const p of got.filter(p => p.targetInfo.type === "iframe")) { await c.send("Runtime.runIfWaitingForDebugger", {}, p.sessionId, 3000).catch(e=>console.log("rif", e.message)); await c.send("Runtime.enable", {}, p.sessionId, 3000).catch(e=>console.log("en", e.message));
  const r = await c.send("Runtime.evaluate", { expression: `JSON.stringify({ url: location.href.slice(0,60), app: !!document.getElementById("app"), iframes: [...document.querySelectorAll("iframe")].map(f => { let ok; try { ok = !!f.contentDocument; } catch(e) { ok = String(e).slice(0,40); } return [f.id, f.src.slice(0,50), ok]; }) })`, returnByValue: true }, p.sessionId, 5000).catch(e => ({ err: e.message }));
  console.log(JSON.stringify(r));
}
process.exit(0);
