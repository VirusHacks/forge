import assert from "node:assert/strict";
import * as vscode from "vscode";
import { suite, test } from "mocha";

import { checkTrueForge } from "../src/health";
import { buildProposedDocument } from "../src/patchSafety";

suite("Forge extension", () => {
  test("activates and registers the environment status command", async () => {
    const extension = vscode.extensions.getExtension("forge-a-thon.forge-a-thon-extension");
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("forge.environmentStatus"));
    assert.ok(commands.includes("forge.taskA"));
    assert.ok(commands.includes("forge.taskACancel"));
    assert.ok(commands.includes("forge.taskAApprove"));
    assert.ok(commands.includes("forge.taskAReject"));
  });

  test("reports an unreachable backend without throwing", async () => {
    assert.equal(await checkTrueForge("http://127.0.0.1:1"), "unreachable");
  });

  test("reports an empty backend URL as not configured", async () => {
    assert.equal(await checkTrueForge(""), "not-configured");
  });

  test("builds a single validated proposal without writing it", () => {
    const original = "def get_debug_flag():\n    return True\n";
    const proposed = buildProposedDocument(
      original,
      original,
      "src/flask/helpers.py",
      {
        path: "src/flask/helpers.py",
        originalText: original.trimEnd(),
        replacementText: "def get_debug_flag():\n    return False",
        explanation: "Task A proposal",
      },
    );
    assert.equal(proposed, "def get_debug_flag():\n    return False\n");
    assert.equal(original, "def get_debug_flag():\n    return True\n");
    assert.throws(() => buildProposedDocument(original, original, "src/flask/helpers.py", {
      path: "other.py",
      originalText: original.trimEnd(),
      replacementText: "changed",
      explanation: "different file",
    }));
  });
});

