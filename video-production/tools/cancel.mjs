// A3 evidence: start Task B, press Stop mid-run, show the cancelled state and a clean worktree.
import { open, recorder, sleep } from "./vscode.mjs";
import path from "node:path";
import { execSync } from "node:child_process";

const WS = "/Users/dakshjain/Desktop/Hackathons/iit-true-forge/scratch/demo-b";
const REQUEST = `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`;
const v = await open({ emulate: true });
const r = recorder(v, path.resolve("../recordings", process.argv[2] ?? "cancel-take1"), { fps: 24 });
const webText = () => v.webEval(`document.getElementById("app").innerText`);
const toolRows = async () => ((await webText()).match(/\n(Search|Read|Stage|Graph lookup|List)\b/g) || []).length;

try {
  r.mark("start"); await sleep(1500);
  await v.webClick("textarea"); await sleep(300);
  await v.type(REQUEST, { cps: 90 });
  await sleep(600);
  r.mark("submit");
  await v.webClickUntil("button.send", "Send", async () => /Stop/.test(await webText()), { wait: 3000 });
  // Let real tool calls stream in before stopping (a run in progress, not an idle one).
  await v.waitFor(async () => (await toolRows()) >= 3, { timeout: 90000, every: 300, label: "tool rows" });
  await sleep(1200);
  r.mark(`stop (tool rows visible: ${await toolRows()})`);
  await v.webClickUntil("button.stop", "Stop", async () => /Cancelled/.test(await webText()), { wait: 4000 });
  r.mark("cancelled");
  await sleep(2500);
  r.mark("terminal");
  await v.key("cmd+j"); await sleep(900);
  await v.click(".terminal-wrapper .xterm-screen"); await sleep(300);
  await v.type(`git status --short && git diff --exit-code && echo "cancelled: nothing written"`, { cps: 45 }); await sleep(300); await v.key("Enter");
  await sleep(3500);
  r.mark("end"); await sleep(800);
  console.log("git status:", JSON.stringify(execSync(`git -C ${WS} status --short`).toString()));
} catch (e) { r.mark("ERROR " + e.message); console.error(e); }
finally { console.log("frames", await r.stop()); process.exit(0); }
