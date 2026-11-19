// Extension-host driver: runs a real agent task through the installed extension end to end.
//   FORGE_UI_AUTO_ACCEPT=1   accept the review when it appears (stands in for clicking "Accept")
//   FORGE_UI_VERIFY_PY=<py>  after apply, run the Task B checks with this Python, then Undo via the extension
//   FORGE_UI_RESULT=<file>   JSON summary
const vscode = require("vscode");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
exports.run = async function () {
  const ext = vscode.extensions.getExtension("forge-a-thon.forge-a-thon-extension");
  const api = await ext.activate();
  await vscode.commands.executeCommand("workbench.view.extension.forge");
  await new Promise(r => setTimeout(r, 2000));
  await api.sidebar.refreshModels();
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const t0 = Date.now();
  let accepted = false;
  const timer = setInterval(() => { if (process.env.FORGE_UI_AUTO_ACCEPT === "1" && api.acceptReview()) accepted = true; }, 1000);
  try { await api.runAgent(process.env.FORGE_UI_TASK, process.env.FORGE_UI_MODEL); } finally { clearInterval(timer); }
  const result = { status: api.sidebar.runStatus, accepted, ms: Date.now() - t0, logs: api.runLogDirectory };
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
  result.changed = git("status", "--short").trim().split("\n").filter(Boolean);
  const py = process.env.FORGE_UI_VERIFY_PY;
  if (py && result.changed.length) {
    const env = { ...process.env, PYTHONPATH: `${root}/src` };
    const run = args => { try { return execFileSync(py, args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return String(e.stdout ?? "") + String(e.stderr ?? ""); } };
    result.pytest = run(["-m", "pytest", "tests/test_cli.py", "-q", "-p", "no:cacheprovider"]).trim().split("\n").pop();
    result.help = run(["-m", "flask", "--help"]).split("\n").filter(l => /^\s+config\b/.test(l));
    const dir = fs.mkdtempSync("/tmp/forge-app-");
    fs.writeFileSync(`${dir}/demo_app.py`, 'from flask import Flask\napp = Flask(__name__)\napp.config.update(SECRET_KEY="s3cr3t", API_TOKEN="tok", DB_PASSWORD="pw", PUBLIC_NAME="Forge demo")\n');
    try { result.config = execFileSync(py, ["-m", "flask", "--app", "demo_app", "config"], { cwd: dir, env: { ...env, PYTHONPATH: `${root}/src:${dir}` }, encoding: "utf8" }).split("\n").filter(l => /SECRET_KEY"|API_TOKEN|DB_PASSWORD|PUBLIC_NAME/.test(l)).map(l => l.trim()); }
    catch (e) { result.config = String(e.stderr ?? e).slice(0, 300); }
    fs.rmSync(dir, { recursive: true, force: true });
    result.diffStat = git("diff", "--stat").trim();
    result.undo = await api.undo();
    result.afterUndo = git("status", "--short").trim();
  }
  if (process.env.FORGE_UI_RESULT) fs.writeFileSync(process.env.FORGE_UI_RESULT, JSON.stringify(result, null, 2));
};
