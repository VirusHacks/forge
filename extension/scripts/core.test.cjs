// Offline unit tests for Forge's harness core. Run with: npm run test:unit
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { ModelRouter, classifyFailure, retryAfterMs, orderCandidates, redact } = require("../out/src/core/router.js");
const { diffLines, applyHunks } = require("../out/src/core/diff.js");
const { runSession } = require("../out/src/core/session.js");
const { Workspace, buildOutline } = require("../out/src/agent/workspace.js");
const { Staging } = require("../out/src/agent/staging.js");
const { assembleContext, extractTerms, roleOf } = require("../out/src/agent/retrieval.js");
const { tokenize, CommandRunner } = require("../out/src/agent/commands.js");
const { applySelection, replacementFromText, inlinePrompt } = require("../out/src/inline/inlineEdit.js");
const { profileFor } = require("../out/src/core/profiles.js");

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-unit-"));
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

// ---------------- router ----------------
test("classifies provider failures; tool/validation errors are not provider faults", () => {
  assert.equal(classifyFailure(new Error("Cannot connect to API: connect ECONNREFUSED 127.0.0.1:1")), "network");
  assert.equal(classifyFailure(new Error("Request failed (401): invalid api key")), "invalid_credentials");
  assert.equal(classifyFailure(new Error("Request failed (429): Rate limit reached ... Please try again in 18.3s")), "rate_limit");
  assert.equal(classifyFailure(new Error("Request failed (429): free-models-per-day exceeded")), "quota");
  assert.equal(classifyFailure(new Error("Request failed (503): This model is currently experiencing high demand")), "server");
  assert.equal(classifyFailure(new Error("tool call validation failed: parameters for tool read_code did not match schema")), "malformed_output");
  assert.equal(classifyFailure(new Error("Selected hunks failed validation")), undefined);
  assert.equal(retryAfterMs(new Error("Please try again in 18.3s.")), 18300);
  assert.equal(retryAfterMs(new Error("Please try again in 154.28ms.")), 155);
});

test("router waits out short rate limits, backs off on 5xx, then switches once per provider", () => {
  const r = new ModelRouter(["groq/a", "groq/b", "gemini/c"], { maxRetriesPerModel: 1, maxRateLimitWaits: 2, maxSwitches: 2, baseBackoffMs: 100 });
  assert.deepEqual(r.decide(new Error("Request failed (429): try again in 2s")).action, "retry");
  assert.deepEqual(r.decide(new Error("Request failed (429): try again in 2s")).action, "retry");
  const sw = r.decide(new Error("Request failed (429): try again in 2s"));
  assert.equal(sw.action, "switch"); assert.equal(sw.to, "groq/b");
  assert.equal(r.decide(new Error("Request failed (503): overloaded")).action, "retry");
  const cred = r.decide(new Error("Request failed (401): invalid api key"));
  assert.equal(cred.action, "switch"); assert.equal(cred.to, "gemini/c", "a provider with bad credentials is not retried with another of its models");
  assert.equal(r.decide(new Error("Request failed (401): invalid api key")).action, "fail");
  assert.equal(r.decide(new Error("some unrelated bug")).action, "fail");
});

test("candidate order keeps the primary and drops unknown fallbacks", () => {
  assert.deepEqual(orderCandidates("a/x", ["b/y", "a/x", "c/z"], ["a/x", "b/y"]), ["a/x", "b/y"]);
  assert.equal(redact("key gsk_FAKEFAKEFAKE00 and org_FAKEFAKEFAKE0"), "key [redacted] and [redacted]");
});

test("budget profiles: tight providers get a compact profile; overrides win", () => {
  assert.equal(profileFor("groq/q", {}, ["groq"]).name, "tight");
  assert.equal(profileFor("google-gemini/f", {}, ["groq"]).name, "standard");
  assert.equal(profileFor("groq/q", { contextBudget: 999 }, ["groq"]).contextBudget, 999);
});

// ---------------- diff + staging ----------------
test("line diff splits independent changes into hunks that apply selectively", () => {
  const base = "a\nb\nc\nd\ne\nf\ng\n", next = "a\nB\nc\nd\ne\nF\ng\nh\n";
  const hunks = diffLines(base, next);
  assert.equal(hunks.length, 2, "changes separated by one unchanged line are merged into one hunk");
  assert.equal(applyHunks(base, hunks, [0, 1]), next);
  assert.equal(applyHunks(base, hunks, [0]), "a\nB\nc\nd\ne\nf\ng\n");
  assert.equal(applyHunks(base, hunks, [1]), "a\nb\nc\nd\ne\nF\ng\nh\n");
  assert.equal(applyHunks(base, hunks, []), base);
});

test("staging: exact, ambiguous, whitespace-repaired, missing with hint, new file", () => {
  const root = repo({ "pkg/m.py": "def f():\n    x = 1\n    return x\n\ndef g():\n    return 2\n" });
  const s = new Staging(new Workspace(root));
  let [r] = s.stage([{ path: "pkg/m.py", find: "    x = 1\n", replace: "    x = 41\n" }]);
  assert.equal(r.status, "applied");
  [r] = s.stage([{ path: "pkg/m.py", find: "return", replace: "yield" }]);
  assert.equal(r.status, "failed"); assert.match(r.message, /occurs 2 times/);
  [r] = s.stage([{ path: "pkg/m.py", find: "x = 41\nreturn x", replace: "x = 42\nreturn x * 2" }]);
  assert.equal(r.status, "repaired", "uniform indentation shift is repaired");
  assert.match(s.snapshot()[0].next, /\n    x = 42\n    return x \* 2\n/);
  [r] = s.stage([{ path: "pkg/m.py", find: "def f(y):\n    x = 1", replace: "" }]);
  assert.equal(r.status, "failed"); assert.match(r.message, /Closest existing lines/);
  [r] = s.stage([{ path: "pkg/new.py", find: "", replace: "VALUE = 1" }]);
  assert.equal(r.status, "created");
  assert.equal(s.hunks().length, 2, "one hunk in m.py, one for the new file");
  assert.equal(fs.readFileSync(path.join(root, "pkg/m.py"), "utf8").includes("x = 1"), true, "disk untouched");
  assert.throws(() => s.stage([{ path: "../escape.py", find: "", replace: "x" }])[0].status === "failed" ? (() => { throw new Error(); })() : null);
});

// ---------------- workspace + retrieval ----------------
test("workspace excludes credentials and hidden dirs; outline finds python and ts symbols", () => {
  const root = repo({ "a.py": "class A:\n    def m(self):\n        return 1\n\ndef top():\n    pass\n", ".env": "SECRET=1", "keys/server.pem": "x", "b.ts": "export function hello(a: number) {\n  return a;\n}\n" });
  const ws = new Workspace(root);
  assert.deepEqual(ws.files, ["a.py", "b.ts"]);
  const out = ws.outline("a.py").map(s => `${s.name}:${s.line}-${s.end}`);
  assert.deepEqual(out, ["A:1-3", "m:2-3", "top:5-6"]);
  assert.equal(ws.findSymbol("a.py", "A.m").line, 2);
  assert.equal(buildOutline("b.ts", fs.readFileSync(path.join(root, "b.ts"), "utf8").split("\n"))[0].end, 3);
});

test("context pack ranks the defining file, its test and docs within budget", async () => {
  const root = repo({
    "src/shop/cart.py": "def add_item(cart, item):\n    cart.append(item)\n\ndef cart_total(cart):\n    return sum(i.price for i in cart)\n",
    "src/shop/users.py": "def login(user):\n    return True\n",
    "tests/test_cart.py": "from shop.cart import cart_total\n\ndef test_cart_total():\n    assert cart_total([]) == 0\n",
    "docs/cart.md": "# Cart\n\nThe cart total sums item prices.\n",
    "CHANGES.md": "cart cart cart total total discount\n",
  });
  const ws = new Workspace(root);
  assert.ok(!extractTerms("must be covered by a test").includes("must"));
  assert.equal(roleOf("tests/test_cart.py"), "test");
  const pack = await assembleContext(ws, "Apply a discount in cart_total and cover it with a test and docs", { budget: 1500 });
  const paths = pack.files.map(f => f.path);
  assert.equal(paths[0] === "src/shop/cart.py" || paths.includes("src/shop/cart.py"), true);
  assert.ok(paths.includes("tests/test_cart.py") && paths.includes("docs/cart.md"), paths.join(","));
  assert.ok(!paths.includes("src/shop/users.py"));
  assert.ok(pack.tokens <= pack.budget);
  assert.ok(pack.files.find(f => f.path === "src/shop/cart.py").reasons.some(r => /defines cart_total/.test(r)));
});

// ---------------- commands ----------------
test("run_command tokenizes without a shell and runs against staged edits in a snapshot", async () => {
  assert.deepEqual(tokenize(`python -c "print(1)"`), ["python", "-c", "print(1)"]);
  assert.throws(() => tokenize("pytest; rm -rf /"), /Shell operators/);
  assert.throws(() => tokenize("cat a | sh"), /Shell operators/);
  const root = repo({ "src/mod.py": "VALUE = 1\n", "check.py": "import mod\nprint('value', mod.VALUE)\n" });
  const ws = new Workspace(root), staging = new Staging(ws);
  staging.stage([{ path: "src/mod.py", find: "VALUE = 1", replace: "VALUE = 2" }]);
  const runner = new CommandRunner(ws, staging, { allowed: ["python3"], timeoutMs: 20000, sandbox: true, python: execFileSync("which", ["python3"], { encoding: "utf8" }).trim() });
  const result = await runner.run("python3 check.py", new AbortController().signal);
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /value 2/);
  assert.equal(fs.readFileSync(path.join(root, "src/mod.py"), "utf8"), "VALUE = 1\n", "workspace untouched");
  await assert.rejects(runner.run("rm -rf src", new AbortController().signal), /not in forge.allowedCommands/);
  runner.dispose();
});

// ---------------- inline edit helpers ----------------
test("inline edit: replaces exactly the selected lines and extracts prose replies", () => {
  const text = "a\nb\nc\nd\n";
  assert.equal(applySelection(text, 1, 2, "B\nC"), "a\nB\nC\nd\n");
  assert.equal(applySelection(text, 1, 2, "B\nC\n"), "a\nB\nC\nd\n");
  assert.equal(replacementFromText('Sure:\n```python\nx = 2\n```').replacement, "x = 2");
  assert.equal(replacementFromText('{"replacement": "y", "explanation": "e"}').replacement, "y");
  assert.match(inlinePrompt({ file: "f.py", languageId: "python", text, startLine: 1, endLine: 2, instruction: "do" }), /Selected lines 2-3/);
});

// ---------------- session runner with a fake TrueForge ----------------
function fakeClient(script) {
  const calls = { updates: [], turns: [], approvals: [], cancels: 0 };
  let turn = 0;
  return {
    calls,
    sessions: {
      create: async () => ({ data: { id: "s1" } }),
      update: async (_id, body) => { calls.updates.push(body); },
      cancel: async () => { calls.cancels++; },
      createTurnEvents: async (_s, _t, body) => { calls.approvals.push(body.events[0].approval); },
      listTurnEvents: async function* () {},
      createTurnStream: async (_s, body) => { calls.turns.push(body); const events = script[turn++]; return (async function* () { for (const e of events) yield typeof e === "function" ? e() : e; })(); },
    },
  };
}
const done = (text) => ({ type: "turn.done", state: { status: "done", output: { content: text } } });
const failed = (message) => ({ type: "turn.done", state: { status: "error", message } });

test("session: provider failure switches the model and continues the same session", async () => {
  const client = fakeClient([
    [{ type: "turn.created", turnId: "t1" }, failed("[Model Error] Cannot connect to API: ECONNREFUSED")],
    [{ type: "turn.created", turnId: "t2" }, { type: "model.message", id: "m1" }, { type: "model.message.delta", content: "ok" }, done("ok")],
  ]);
  const events = [];
  const router = new ModelRouter(["broken/x", "good/y"], { maxRetriesPerModel: 0 });
  const result = await runSession({ client, baseUrl: "http://localhost:8790", agentName: "a", buildSpec: m => ({ model: { name: m } }), router, title: "t", input: "hi", signal: new AbortController().signal, emit: e => events.push(e), wait: async () => {} });
  assert.equal(result.finalText, "ok");
  assert.deepEqual(result.models, ["broken/x", "good/y"]);
  assert.equal(client.calls.updates.at(-1).agent.spec.model.name, "good/y", "the live session's agent spec is updated");
  assert.equal(client.calls.turns[1].previousTurnId, "t1", "the next turn continues from the failed turn");
  assert.ok(events.some(e => e.type === "model.switch" && e.to === "good/y"));
});

test("session: approval requests drive review and finish the turn without extra model calls", async () => {
  const client = fakeClient([[
    { type: "turn.created", turnId: "t1" }, { type: "model.message", id: "m1" },
    { type: "tool.approval_required", threadId: "main", toolCalls: [{ id: "c1", function: { name: "submit_for_review", arguments: '{"summary":"s"}' } }] },
    { type: "model.message", id: "m2" },
    { type: "turn.done", state: { status: "cancelled" } },
  ]]);
  let asked;
  const result = await runSession({ client, baseUrl: "u", agentName: "a", buildSpec: m => ({ model: m }), router: new ModelRouter(["m/x"]), title: "t", input: "go", signal: new AbortController().signal, emit: () => {},
    onApproval: async req => { asked = req; return { allow: true, finish: true }; } });
  assert.equal(asked.toolName, "submit_for_review");
  assert.deepEqual(asked.arguments, { summary: "s" });
  assert.deepEqual(client.calls.approvals, [{ status: "allow" }]);
  assert.equal(result.finishedEarly, true);
  assert.equal(result.modelCalls, 1, "the closing model call is cancelled");
});

test("session: cancellation aborts without switching models", async () => {
  const controller = new AbortController();
  const client = fakeClient([[{ type: "turn.created", turnId: "t1" }, () => { controller.abort(); return { type: "model.message", id: "m1" }; }]]);
  await assert.rejects(runSession({ client, baseUrl: "u", agentName: "a", buildSpec: m => ({ model: m }), router: new ModelRouter(["a/x", "b/y"]), title: "t", input: "go", signal: controller.signal, emit: () => {} }));
  assert.equal(client.calls.updates.filter(u => u.agent).length, 0);
});

test("inline edit: truncated or signature-less replacements are sent back to the model", () => {
  const { checkReplacement } = require("../out/src/inline/inlineEdit.js");
  const sel = 'def f(x):\n    """Doc."""\n    y = x\n    return y';
  assert.match(checkReplacement(sel, '    """New doc."""', "update the docstring"), /definition line/);
  assert.match(checkReplacement("a = 1\nb = 2\nc = 3\nd = 4\ne = 5", "a = 1", "rename b"), /truncated/);
  assert.equal(checkReplacement(sel, 'def f(x):\n    """New."""\n    y = x\n    return y', "doc"), undefined);
  assert.equal(checkReplacement(sel, "pass", "remove the body"), undefined);
});

test("auto-verify infers the tests for staged changes and reports them without a model call", async () => {
  const { AgentTools } = require("../out/src/agent/tools.js");
  const root = repo({ "src/calc.py": "def add(a, b):\n    return a - b\n", "tests/test_calc.py": "import calc\n\ndef test_add():\n    assert calc.add(1, 2) == 3\n" });
  const python = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
  // Minimal pytest stand-in so the test does not depend on pytest being installed.
  const events = [];
  const tools = new AgentTools(new Workspace(root), undefined, { maxResultChars: 6000, allowedCommands: ["python"], python, commandTimeoutMs: 20000, sandboxCommands: true, autoVerify: true, verifyCommand: "python -c \"import sys; sys.path.insert(0,'tests'); import test_calc; test_calc.test_add(); print('1 passed')\"" }, e => events.push(e), new AbortController().signal);
  const out = await tools["stage"]([{ path: "src/calc.py", find: "return a - b", replace: "return a + b" }]);
  assert.match(out.text, /Auto-verification .* no new failures/);
  assert.match(out.summary, /tests ✓/);
  assert.ok(events.some(e => e.type === "tool.start" && /Auto-verify/.test(e.title)));
  assert.equal(tools.commands.last.exitCode, 0);
  const tools2 = new AgentTools(new Workspace(root), undefined, { maxResultChars: 6000, allowedCommands: ["python"], commandTimeoutMs: 1, sandboxCommands: true }, () => {}, new AbortController().signal);
  tools2.staging.stage([{ path: "src/calc.py", find: "return a - b", replace: "return a + b" }]);
  assert.equal(tools2.inferVerifyCommand(), "python -m pytest tests/test_calc.py -q --no-header", "tests named after the staged module are inferred");
});

test("staging skips an insertion that is already staged", () => {
  const root = repo({ "m.py": "def a():\n    pass\n\n\ndef b():\n    pass\n" });
  const s = new Staging(new Workspace(root));
  const edit = { path: "m.py", find: "def b():\n    pass\n", replace: "def b():\n    pass\n\n\ndef c():\n    return 3\n" };
  s.stage([edit]);
  const [again] = s.stage([edit]);
  assert.match(again.message, /already staged/);
  assert.equal((s.snapshot()[0].next.match(/def c\(\)/g) || []).length, 1);
});

test("auto-verify ignores failures that already exist without the staged change", async () => {
  const { AgentTools } = require("../out/src/agent/tools.js");
  const root = repo({ "src/calc.py": "X = 1\n", "tests/test_calc.py": "def test_x():\n    pass\n" });
  const python = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
  // Always reports the same pre-existing failure, with or without the staged change.
  const cmd = `python -c "print('FAILED tests/test_old.py::test_flaky - boom'); raise SystemExit(1)"`;
  const tools = new AgentTools(new Workspace(root), undefined, { maxResultChars: 6000, allowedCommands: ["python"], python, commandTimeoutMs: 20000, sandboxCommands: true, autoVerify: true, verifyCommand: cmd }, () => {}, new AbortController().signal);
  const out = await tools["stage"]([{ path: "src/calc.py", find: "X = 1", replace: "X = 2" }]);
  assert.match(out.text, /no new failures/);
  assert.match(out.text, /also fail without your change: tests\/test_old.py::test_flaky/);
  assert.equal(tools.commands.last.exitCode, 0, "the review badge shows no new failures");
});

test("committed dotenv fixtures reach command snapshots but never agent reads", () => {
  const root = repo({ "tests/apps/.env": "FOO=env\n", "a.py": "x = 1\n" });
  const ws = new Workspace(root);
  assert.ok(ws.snapshotFiles.includes("tests/apps/.env"));
  assert.ok(!ws.files.includes("tests/apps/.env"));
  assert.throws(() => ws.source("tests/apps/.env"));
});

test("'Request too large' is a size failure even when sent as 429", () => {
  assert.equal(classifyFailure(new Error("Request failed (429): Request too large for model `qwen` on output tokens per minute (OTPM): Limit 1000")), "context_exceeded");
});
