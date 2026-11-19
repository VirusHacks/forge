import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { suite, test } from "mocha";
import * as vscode from "vscode";
import { TaskAController } from "../src/taskA";

suite("Task A review guards", () => {
  for (const action of ["reject", "cancel review", "approve stale"] as const) {
    test(action + " preserves the file", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "forge-review-test-"));
      const file = path.join(dir, "example.py");
      const controller = new TaskAController();
      try {
        const original = "before\n";
        await writeFile(file, original);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        controller["pendingProposal"] = {
          sourceUri: doc.uri, previewUri: vscode.Uri.parse("forge-preview:/example.py"),
          originalVersion: doc.version, originalDocument: original, proposedDocument: "after\n",
          range: new vscode.Range(0, 0, 1, 0), replacement: "after\n",
          targetRelativePath: "example.py", sessionId: "test", turnId: "test", agentName: "test",
          explanation: "", modelName: "test", modelCalls: 0, inputTokens: 0, outputTokens: 0,
          retries: 0, toolCounts: {read_file: 0, search_repository: 0}, eventCounts: {},
        };
        if (action === "approve stale") {
          await writeFile(file, "user edit\n");
          await controller.approveProposal();
        } else if (action === "cancel review") {
          await controller.cancel();
        } else {
          await controller.rejectProposal();
        }
        assert.equal(await readFile(file, "utf8"), action === "approve stale" ? "user edit\n" : original);
        assert.equal(controller["pendingProposal"], undefined);
      } finally {
        controller.dispose();
        await rm(dir, {recursive: true, force: true});
      }
    });
  }
});
