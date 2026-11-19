const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { before, after, test } = require("node:test");
const { validateTaskB } = require("../out/src/taskBValidate.js");

const project = path.resolve(__dirname, "../..");
const fixture = path.join(project, "fixtures/flask-3.1.3");
const rehearsal = path.join(project, "scratch/flask-task-b");
const pin = "22d924701a6ae2e4cd01e9a15bbaf3946094af65";
const git = (cwd, ...args) => execFileSync("/usr/bin/git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8" });
let temp, root, clone, files;

before(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "verify-flask-test-")));
  root = path.join(temp, "worktree");
  clone = path.join(temp, "repo");
  git(temp, "clone", "--quiet", "--no-hardlinks", "--no-checkout", fixture, clone);
  git(clone, "worktree", "add", "--quiet", "--detach", root, pin);
  files = {};
  for (const file of git(rehearsal, "diff", "--name-only", "-z", pin).split("\0").filter(Boolean)) {
    files[file] = await fs.readFile(path.join(rehearsal, file), "utf8");
  }
});
after(async () => { if (temp) await fs.rm(temp, { recursive: true, force: true }); });

test("checks out only clean, pinned, linked roots", async () => {
  for (const badRoot of [fixture, clone, path.join(root, "src")]) {
    const result = await validateTaskB(badRoot, {});
    assert.equal(result.ok, false);
    assert.match(result.summary, /worktree/i);
  }
  const extra = path.join(root, "untracked");
  await fs.writeFile(extra, "keep");
  try {
    assert.match((await validateTaskB(root, {})).summary, /clean/i);
  } finally {
    await fs.unlink(extra);
  }
  git(root, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--quiet", "--allow-empty", "-m", "wrong pin");
  try {
    assert.match((await validateTaskB(root, {})).summary, /pin/i);
  } finally {
    git(root, "checkout", "--quiet", "--detach", pin);
  }
});

test("rejects noncanonical, untracked and non-file replacement keys", async () => {
  for (const key of ["../escape", "/etc/hosts", ".git", ".git/config", "src", "README.MD", "new.py", "src/../README.md"]) {
    const result = await validateTaskB(root, { [key]: "" });
    assert.equal(result.ok, false);
    assert.match(result.summary, /tracked regular file/i);
  }
});

test("the pinned CLI suite passes on baseline, then real help rejects missing config", async () => {
  const result = await validateTaskB(root, {});
  assert.equal(result.ok, false);
  assert.match(result.summary, /58 passed/);
  assert.match(result.summary, /help/i);
});

test("runs the rehearsal's proposed suite and real CLI with factory and instance", async () => {
  const result = await validateTaskB(root, files);
  assert.equal(result.ok, true, result.summary);
  assert.match(result.summary, /60 passed/);
  assert.match(result.summary, /factory/i);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("candidate tests see a git-free source copy and private scratch under OS confinement", async () => {
  const sentinel = path.join(temp, "outside");
  await fs.writeFile(sentinel, "untouched");
  const tests = files["tests/test_cli.py"] + `
def test_os_confinement(tmp_path):
    import socket
    import subprocess
    outside = Path(${JSON.stringify(sentinel)})
    assert not Path(".git").exists()
    assert Path.cwd() != Path(${JSON.stringify(root)})
    assert Path(__import__("flask").__file__).parent == Path.cwd() / "src/flask"
    for operation in (outside.read_text, lambda: outside.write_text("changed"),
                      lambda: subprocess.run(["/usr/bin/true"], check=True)):
        with pytest.raises(PermissionError):
            operation()
    with pytest.raises(PermissionError), socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
    (tmp_path / "inside").write_text("allowed")
`;
  const result = await validateTaskB(root, { ...files, "tests/test_cli.py": tests });
  assert.equal(result.ok, true, result.summary);
  assert.match(result.summary, /61 passed/);
  assert.equal(await fs.readFile(sentinel, "utf8"), "untouched");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("a failing proposed CLI test fails verification", async () => {
  const tests = files["tests/test_cli.py"] + "\ndef test_regression():\n    assert False\n";
  const result = await validateTaskB(root, { ...files, "tests/test_cli.py": tests });
  assert.equal(result.ok, false);
  assert.match(result.summary, /pytest/i);
});

test("an already cancelled or interrupted check cannot succeed", async () => {
  const cancelled = await validateTaskB(root, {}, AbortSignal.abort());
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.summary, /cancel/i);
  const controller = new AbortController();
  const tests = files["tests/test_cli.py"] + "\ndef test_slow():\n    import time\n    time.sleep(30)\n";
  const pending = validateTaskB(root, { ...files, "tests/test_cli.py": tests }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 850);
  try {
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.summary, /cancel/i);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(git(root, "status", "--porcelain"), "");
});
