// Task A (and Task C with TASK=C): inline edit of get_debug_flag, recorded from the real VS Code window.
import { open, recorder, sleep } from "./vscode.mjs";
import path from "node:path";
import { execSync } from "node:child_process";
const WS = process.env.WS ?? "/Users/dakshjain/Desktop/Hackathons/iit-true-forge/scratch/demo-a";
const clean = () => execSync(`git -C ${WS} status --short`).toString().trim() === "";

const TASK = process.env.TASK ?? "A";
const name = process.argv[2] ?? `task-${TASK.toLowerCase()}`;
const INSTRUCTION = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const v = await open({ emulate: true });
const dir = path.resolve("../recordings", name);
const r = recorder(v, dir, { fps: 24 });
const webText = () => v.webEval(`document.getElementById("app").innerText`);
const lens = text => v.box(".codelens-decoration a", text);

try {
  r.mark("start");
  await sleep(2500);
  if (TASK === "C") {
    // Show the failure configuration: fallback setting, and an endpoint that refuses connections.
    r.mark("config: fallback setting");
    await sleep(3500);
    await v.key("cmd+j"); await sleep(900);
    await v.click(".terminal-wrapper, .xterm-screen"); await sleep(300);
    r.mark("config: endpoint unreachable");
    await v.type("clear", { cps: 40 }); await v.key("Enter"); await sleep(400);
    await v.type("curl -sS -m 2 http://127.0.0.1:18791/v1/models", { cps: 40 }); await sleep(300); await v.key("Enter"); await sleep(3500);
    await v.key("cmd+j"); await sleep(600);
    await v.click(".tab", "helpers.py"); await sleep(1200);
    await v.click(".monaco-editor .view-lines"); await sleep(300);
  }
  // Select the whole function by keyboard: go to line 28, extend six lines.
  await v.key("ctrl+g"); await sleep(500); await v.type("28", { cps: 6 }); await sleep(400); await v.key("Enter"); await sleep(700);
  r.mark("select");
  for (let i = 0; i < 6; i++) { await v.key("shift+ArrowDown", { delay: 60 }); await sleep(120); }
  await sleep(1200);
  r.mark("keybinding cmd+alt+k");
  await v.key("cmd+alt+k"); await sleep(1200);
  r.mark("typing instruction");
  await v.type(INSTRUCTION, { cps: 32 });
  await sleep(900);
  r.mark("submit");
  await v.key("Enter");
  if (TASK === "C") {
    // Resilience: the run either fails clearly or falls back; wait for whichever happens.
    // The editor stays responsive while Forge retries: scroll the file during the wait.
    await sleep(1500);
    const ed = await v.box(".monaco-editor .view-lines");
    if (ed) { r.mark("scroll during retries"); for (const dy of [120, 120, 120, -120, -120, -120]) { await v.c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ed.x, y: ed.y, deltaX: 0, deltaY: dy }); await sleep(350); } }
    const outcome = await v.waitFor(async () => /Accept \d of \d/.test(await webText()) ? "diff" : /Stopped|could not reach|Error|failed/i.test(await webText()) && !(await webText()).includes("Retrying") ? "error" : null, { timeout: 180000, label: "C outcome" });
    r.mark(`outcome ${outcome}`);
    await sleep(4000);
    if (outcome === "diff") {
      await sleep(2500);
      r.mark("reject all");
      await v.webClickUntil("button", "Reject all", async () => !/Reject all/.test(await webText()), { wait: 4000 }); await sleep(1500);
      await v.waitFor(async () => /Rejected|unchanged/i.test(await webText()), { timeout: 30000, label: "rejected" }).catch(() => undefined);
      await sleep(2500);
    }
  } else {
    await v.waitFor(async () => /Accept \d of \d/.test(await webText()), { timeout: 240000, label: "diff" });
    r.mark("diff visible");
    await sleep(5000);
    // Per-hunk control: untick hunk 1 (button becomes "Accept 1 of 2"), tick it again, then accept.
    r.mark("toggle hunk 1 off");
    const label = () => v.webEval(`document.querySelector("button.primary")?.textContent || ""`);
    await v.webClickUntil("input[type=checkbox]", undefined, async () => /Accept 1 of/.test(await label())); await sleep(1600);
    r.mark("toggle hunk 1 on");
    await v.webClickUntil("input[type=checkbox]", undefined, async () => /Accept 2 of/.test(await label())); await sleep(1300);
    r.mark("accept");
    await v.webClickUntil("button.primary", "Accept ", async () => /Applied|Undo/.test(await webText()), { wait: 4000 }); await sleep(800);
    await v.waitFor(async () => /Applied/i.test(await webText()), { timeout: 30000, label: "applied" });
    r.mark("applied");
    await sleep(2000);
    // Scroll the saved file so the new function is centred.
    await v.key("ctrl+g"); await sleep(300); await v.type("28", { cps: 8 }); await v.key("Enter"); await sleep(2500);
  }
  r.mark("terminal");
  await v.key("cmd+j"); await sleep(900);
  await v.click(".terminal-wrapper, .xterm-screen"); await sleep(400);
  const run = async (cmd, wait = 3500) => { r.mark(`cmd ${cmd}`); await v.type(cmd, { cps: 40 }); await sleep(300); await v.key("Enter"); await sleep(wait); };
  await run("clear", 600);
  if (TASK === "C") {
    await run("git status --short", 2500);
    await run("git diff --exit-code && echo \"workspace unchanged\"", 4500);
  } else {
    await run(`FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`, 4500);
    await run(`for v in OFF Off n N no 1 true; do printf "%-5s -> " $v; FLASK_DEBUG=$v python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"; done`, 6500);
    if (process.env.UNDO === "1") {
      r.mark("undo");
      await v.webClickUntil("button", "Undo", async () => clean(), { wait: 4000 }); await sleep(2000);
      await run("git status --short && git diff --exit-code && echo \"restored: workspace clean\"", 4000);
    }
  }
  r.mark("end");
  await sleep(1500);
} catch (e) { r.mark("ERROR " + e.message); console.error(e); }
finally { console.log("frames", await r.stop()); process.exit(0); }
