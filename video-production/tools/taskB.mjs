// Task B: agent mode, recorded from the real VS Code window. Nothing is simulated:
// the instruction is typed into the Forge panel and every result comes from TrueForge and the model.
import { open, recorder, sleep } from "./vscode.mjs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";

const name = process.argv[2] ?? "task-b";
const WS = "/Users/dakshjain/Desktop/Hackathons/iit-true-forge/scratch/demo-b";
const RUNS = "/Users/dakshjain/Desktop/Hackathons/iit-true-forge/scratch/vd/User/globalStorage/forge-a-thon.forge-a-thon-extension/runs";
const INSTRUCTION = `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`;
const clean = () => execSync(`git -C ${WS} status --short`).toString().trim() === "";

const v = await open({ emulate: true });
const r = recorder(v, path.resolve("../recordings", name), { fps: 20 });
const webText = () => v.webEval(`document.getElementById("app").innerText`);
const termText = () => v.eval(`[...document.querySelectorAll(".terminal-wrapper .xterm-rows > div")].map(d => d.textContent).join("\\n")`);
const feedWheel = async (dy, n, gap = 260) => {
  const b = await v.box(".part.sidebar");
  for (let i = 0; i < n; i++) { await v.c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: b.x, y: b.y - 60, deltaX: 0, deltaY: dy }); await sleep(gap); }
};
const run = async (cmd, { wait = 2500, until } = {}) => {
  r.mark(`cmd ${cmd}`);
  await v.click(".terminal-wrapper .xterm-screen"); await sleep(200);
  await v.type(cmd, { cps: 45 }); await sleep(250); await v.key("Enter");
  if (until) await v.waitFor(async () => until.test(await termText()), { timeout: 120000, label: cmd }).catch(() => undefined);
  await sleep(wait);
};
const command = async text => { await v.key("cmd+shift+p"); await sleep(500); await v.type(text, { cps: 70 }); await sleep(700); await v.key("Enter"); await sleep(700); };

try {
  r.mark("start");
  await sleep(2500);
  r.mark("typing instruction");
  await v.webClick("textarea"); await sleep(300);
  await v.type(INSTRUCTION, { cps: 42 });
  await sleep(1200);
  r.mark("submit");
  await v.webClickUntil("button.send", "Send", async () => /Stop/.test(await webText()), { wait: 3000 });

  const outcome = await v.waitFor(async () => {
    const t = await webText();
    if (/Accept \d+ of \d+/.test(t)) return "review";
    if (/\b(Stopped|Done|Cancelled)\b ·/.test(t)) return "ended";
    return null;
  }, { timeout: 25 * 60000, every: 1000, label: "review" });
  r.mark(`outcome ${outcome}`);
  if (outcome !== "review") throw new Error("run ended without a review");
  await sleep(1500);
  const card = await webText();
  const files = new Set([...card.matchAll(/((?:src|tests|docs)\/[\w./-]+):\d+/g)].map(m => m[1]));
  r.mark(`review files ${[...files].join(", ")}`);
  if (/stopped early/i.test(card) || files.size < 3) {
    r.mark("FAILED TAKE: incomplete proposal, rejecting");
    await v.webClickUntil("button", "Reject all", async () => !/Reject all/.test(await webText()), { wait: 4000 });
    throw new Error("incomplete proposal: " + [...files].join(", "));
  }
  await sleep(1500);

  // Tour of the run while TrueForge waits for the approval: context pack, graph, tool timeline.
  r.mark("tour: top (context pack)");
  await feedWheel(-600, 25, 40); await sleep(4500);
  r.mark("tour: scroll timeline");
  await feedWheel(220, 14, 520); await sleep(800);
  await feedWheel(400, 30, 60); await sleep(1500);
  r.mark("tour: review card");

  // The proposed diffs, one tab per file.
  const tabs = await v.eval(`[...document.querySelectorAll(".tab")].map(t => t.getAttribute("aria-label") || t.textContent).filter(t => /Forge proposal/.test(t))`);
  r.mark(`diff tabs ${tabs.length}`);
  for (const t of tabs) {
    const label = t.split("↔")[0].trim().split(",")[0];
    r.mark(`diff ${label}`);
    await v.click(".tab", label.split("/").pop()); await sleep(1200);
    await v.key("alt+F5"); await sleep(2600);
  }

  // The TrueForge session for this run, opened inside VS Code.
  const log = readdirSync(RUNS).filter(f => f.endsWith(".jsonl")).map(f => path.join(RUNS, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const url = readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === "session")?.url;
  r.mark(`session ${url}`);
  await command("Simple Browser: Show"); await sleep(400);
  await v.paste(url); await v.key("Enter"); await sleep(6500);
  const sb = await v.box(".editor-group-container .webview, .editor-instance iframe, .part.editor");
  for (const dy of [300, 300, 300, 300, 300, 300]) { await v.c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: sb.x, y: sb.y, deltaX: 0, deltaY: dy }); await sleep(900); }
  await sleep(2500);
  r.mark("session shown");

  // Accept every hunk.
  r.mark("accept");
  await v.webClickUntil("button.primary", "Accept ", async () => !clean(), { wait: 5000 });
  await v.waitFor(async () => /Applied/i.test(await webText()), { timeout: 30000, label: "applied" }).catch(() => undefined);
  r.mark("applied");
  await sleep(2500);

  // Verification in the integrated terminal, maximised for legibility.
  r.mark("terminal");
  await v.key("cmd+j"); await sleep(800);
  await command("View: Toggle Maximized Panel"); await sleep(600);
  await run("clear", { wait: 400 });
  await run("pytest tests/test_cli.py -q", { until: /passed|failed|error/, wait: 4500 });
  await run("cat ../task-b-app/demo_app.py && export FLASK_APP=../task-b-app/demo_app.py", { wait: 3500 });
  await run("clear", { wait: 400 });
  await run("flask --help", { wait: 5000 });
  await run("flask config", { wait: 6000 });
  await run("git status --short", { wait: 3500 });

  // Undo the applied change and show the workspace is restored.
  r.mark("undo");
  await v.webClickUntil("button", "Undo", async () => clean(), { wait: 5000 });
  await sleep(1500);
  await run("git status --short && git diff --exit-code && echo \"undo: all files restored\"", { wait: 4000 });
  r.mark("end");
  await sleep(1500);
} catch (e) { r.mark("ERROR " + e.message); console.error(e); }
finally { console.log("frames", await r.stop()); process.exit(0); }
