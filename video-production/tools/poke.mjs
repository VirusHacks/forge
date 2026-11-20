import { open, sleep } from "./vscode.mjs";
const v = await open();
await sleep(300);
const body = process.argv[2];
const fn = new Function("v", "sleep", `return (async () => { ${body} })()`);
try { const out = await fn(v, sleep); if (out !== undefined) console.log(typeof out === "string" ? out : JSON.stringify(out, null, 1)); }
catch (e) { console.error("ERR", e.message); }
v.c.close(); process.exit(0);
