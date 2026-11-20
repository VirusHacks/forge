// Records the real VS Code window to recordings/<name>/frames until <dir>/STOP exists.
import { open, recorder, sleep } from "./vscode.mjs";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
const name = process.argv[2]; const fps = Number(process.argv[3] ?? 24);
const dir = path.resolve("../recordings", name);
const v = await open({ emulate: true });
const r = recorder(v, dir, { fps });
writeFileSync(path.join(dir, "started"), String(Date.now()));
console.log("recording", dir);
while (!existsSync(path.join(dir, "STOP"))) await sleep(200);
const n = await r.stop(); console.log("frames", n, "seconds", r.elapsed()); process.exit(0);
