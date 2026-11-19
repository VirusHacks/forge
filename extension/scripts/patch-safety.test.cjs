const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildProposedDocument, parseTaskAProposal } = require("../out/src/patchSafety.js");

test("a proposed replacement is validated and remains in memory", () => {
  const original = "def get_debug_flag():\n    return True\n";
  const result = buildProposedDocument(original, original, "src/flask/helpers.py", {
    path: "src/flask/helpers.py",
    originalText: original.trimEnd(),
    replacementText: "def get_debug_flag():\n    return False",
    explanation: "Task A proposal",
  });
  assert.equal(result, "def get_debug_flag():\n    return False\n");
  assert.equal(original, "def get_debug_flag():\n    return True\n");
});

test("a proposal cannot target another file, omit selection, or replace an ambiguous snippet", () => {
  const source = "def get_debug_flag():\n    return True\n";
  const base = { originalText: source.trimEnd(), replacementText: "changed", explanation: "change" };
  assert.throws(() => buildProposedDocument(source, source, "src/flask/helpers.py", { ...base, path: "elsewhere.py" }));
  assert.throws(() => buildProposedDocument(source, "different selection", "src/flask/helpers.py", { ...base, path: "src/flask/helpers.py" }));
  assert.throws(() => buildProposedDocument(source + source, source, "src/flask/helpers.py", { ...base, path: "src/flask/helpers.py" }));
});

test("the final patch response must have the required JSON shape", () => {
  assert.deepEqual(parseTaskAProposal(JSON.stringify({
    path: "src/flask/helpers.py",
    originalText: "old",
    replacementText: "new",
    explanation: "reason",
  })), {
    path: "src/flask/helpers.py",
    originalText: "old",
    replacementText: "new",
    explanation: "reason",
  });
  assert.throws(() => parseTaskAProposal("not json"));
});

test("a model cannot extend the hunk past the selection and dollar signs stay literal", () => {
  const selected = "def get_debug_flag():\n    return True";
  const source = selected + "\n\nother = 42\n";
  const path = "src/flask/helpers.py";
  const proposal = { path, originalText: selected, replacementText: selected.replace("True", '"$&"'), explanation: "change" };
  assert.equal(buildProposedDocument(source, selected, path, proposal), proposal.replacementText + "\n\nother = 42\n");
  assert.throws(() => buildProposedDocument(source, selected, path, {...proposal, originalText: source}));
});
