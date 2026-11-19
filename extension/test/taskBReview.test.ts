import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setup, suite, teardown, test } from "mocha";
import * as vscode from "vscode";
import { reviewTaskB, type BHunk, type TaskBReviewOptions } from "../src/taskBReview";

suite("Task B editor transaction", function () {
  this.timeout(30_000);
  const base = { "a.txt": "one two three\n", "b.txt": "four five\n" };
  const hunks: BHunk[] = [
    { path: "a.txt", original: "one", replacement: "ONE" },
    { path: "a.txt", original: "three", replacement: "3" },
    { path: "b.txt", original: "four", replacement: "4" },
  ];
  let root: string;
  let abort: AbortController;
  let decisions: boolean[];
  let opts: TaskBReviewOptions;
  const at = (name: string) => path.join(root, name);
  const doc = (name: string) => vscode.workspace.openTextDocument(vscode.Uri.file(at(name)));
  const run = (options = opts) => reviewTaskB(root, hunks, base, options);

  setup(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-task-b-")));
    for (const [name, content] of Object.entries(base)) await writeFile(at(name), content);
    abort = new AbortController();
    decisions = [];
    opts = {
      signal: abort.signal,
      select: async () => [0, 2],
      validate: async () => ({ ok: true, summary: "OK" }),
      approve: async allowed => { decisions.push(allowed); },
      confirmSave: async () => false,
    };
  });

  teardown(async () => {
    // Dispose only the temporary fixture's dirty buffers before deleting its directory.
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === "file" && path.dirname(document.uri.fsPath) === root && document.isDirty) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  test("reviews individual diffs and saves all approved files only after one explicit choice", async () => {
    const events: string[] = [];
    const result = await run({
      ...opts,
      select: async previews => {
        for (const [i, expected] of ["ONE two three\n", "one two 3\n", "4 five\n"].entries()) {
          const { before, after, hunk } = previews[i];
          assert.ok(vscode.window.tabGroups.all.some(g => g.tabs.some(t =>
            t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === after.toString())));
          assert.equal((await vscode.workspace.openTextDocument(before)).getText(), base[hunk.path as keyof typeof base]);
          assert.equal((await vscode.workspace.openTextDocument(after)).getText(), expected);
          assert.equal((await doc(hunk.path)).isDirty, false);
        }
        events.push("select");
        return [2, 0];
      },
      validate: async selected => {
        assert.deepEqual(selected, [hunks[0], hunks[2]]);
        events.push("validate");
        return { ok: true, summary: "OK" };
      },
      approve: async allowed => {
        assert.equal(allowed, true);
        assert.equal(await readFile(at("a.txt"), "utf8"), base["a.txt"]);
        events.push("approve");
      },
      confirmSave: async paths => {
        assert.deepEqual(paths, ["a.txt", "b.txt"]);
        events.push("save-confirm");
        return true;
      },
    });
    assert.deepEqual(result, { applied: true, selected: [hunks[0], hunks[2]] });
    assert.deepEqual(events, ["select", "validate", "approve", "validate", "save-confirm"]);
    assert.equal(await readFile(at("a.txt"), "utf8"), "ONE two three\n");
    assert.equal(await readFile(at("b.txt"), "utf8"), "4 five\n");
    assert.equal((await doc("a.txt")).isDirty, false);
    assert.equal((await doc("b.txt")).isDirty, false);
  });

  test("a failed later save rolls earlier files back and leaves the full patch unsaved", async () => {
    const recovery = path.join(root, "recovery");
    let saveCalls = 0;
    opts.confirmSave = async paths => { assert.deepEqual(paths, ["a.txt", "b.txt"]); return true; };
    const result = await run({
      ...opts,
      recoveryDirectory: recovery,
      saveDocument: async document => {
        saveCalls++;
        if (document.uri.fsPath === at("b.txt")) return false;
        return document.save();
      },
    });
    assert.equal(result.applied, true);
    assert.equal(saveCalls, 2);
    assert.equal(await readFile(at("a.txt"), "utf8"), base["a.txt"]);
    assert.equal(await readFile(at("b.txt"), "utf8"), base["b.txt"]);
    assert.equal((await doc("a.txt")).getText(), "ONE two three\n");
    assert.equal((await doc("b.txt")).getText(), "4 five\n");
    assert.equal((await doc("a.txt")).isDirty, true);
    assert.equal((await doc("b.txt")).isDirty, true);
    assert.deepEqual(await readdir(recovery), []);
  });

  test("reverse-ordered hunks of different lengths share the source offsets and one undo", async () => {
    const document = await doc("a.txt");
    await vscode.window.showTextDocument(document);
    await reviewTaskB(root, [hunks[1], { ...hunks[0], replacement: "a longer string" }], base,
      { ...opts, select: async () => [0, 1] });
    assert.equal(document.getText(), "a longer string two 3\n");
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("undo");
    assert.equal(document.getText(), base["a.txt"]);
  });

  for (const action of ["cancel", "reject all", "abort", "incoherent", "invalid index", "duplicate index"] as const) {
    test(action + " leaves both files clean and denies approval", async () => {
      opts.select = async () => {
        if (action === "abort") abort.abort();
        if (action === "cancel") return undefined;
        if (action === "reject all") return [];
        if (action === "invalid index") return [7];
        if (action === "duplicate index") return [0, 0];
        return [0];
      };
      opts.validate = async () => ({ ok: false, summary: "requires companion hunk" });
      if (action === "incoherent" || action.endsWith("index")) await assert.rejects(run());
      else assert.deepEqual(await run(), { applied: false, selected: [] });
      assert.deepEqual(decisions, [false]);
      for (const [name, expected] of Object.entries(base)) {
        assert.equal((await doc(name)).isDirty, false);
        assert.equal(await readFile(at(name), "utf8"), expected);
      }
    });
  }

  test("overlap is checked on the selected subset", async () => {
    const alternatives = [hunks[0], { ...hunks[0], original: "one two" }];
    await assert.rejects(reviewTaskB(root, alternatives, base, { ...opts, select: async () => [0, 1] }), /overlap/i);
    assert.deepEqual(decisions, [false]);
    await reviewTaskB(root, alternatives, base, { ...opts, select: async () => [1] });
    assert.equal((await doc("a.txt")).getText(), "ONE three\n");
  });

  for (const action of ["disk", "version", "abort", "validator", "approval failure", "symlink swap"] as const) {
    test(action + " during approval prevents the entire edit", async () => {
      const document = await doc("b.txt");
      opts.approve = async allowed => {
        decisions.push(allowed);
        if (action === "disk") await writeFile(at("b.txt"), "external edit\n");
        if (action === "version") {
          await vscode.window.showTextDocument(document);
          const edit = new vscode.WorkspaceEdit();
          edit.insert(document.uri, new vscode.Position(0, 0), "user");
          await vscode.workspace.applyEdit(edit);
          await vscode.commands.executeCommand("undo");
          assert.equal(document.getText(), base["b.txt"]);
        }
        if (action === "abort") abort.abort();
        if (action === "approval failure") throw new Error("approval unavailable");
        if (action === "symlink swap") {
          await rename(at("b.txt"), at("other.txt"));
          await symlink(at("other.txt"), at("b.txt"));
        }
      };
      opts.validate = async () => ({ ok: !(decisions.length && action === "validator"), summary: "changed" });
      if (action === "abort") assert.equal((await run()).applied, false);
      else await assert.rejects(run());
      assert.deepEqual(decisions, [true]);
      assert.equal((await doc("a.txt")).getText(), base["a.txt"]);
      assert.equal(await readFile(at("b.txt"), "utf8"), action === "disk" ? "external edit\n" : base["b.txt"]);
    });
  }

  test("rejects unsafe paths, symlink components, stale bases, ambiguous and missing originals before review", async () => {
    await mkdir(at("nested"));
    await writeFile(at("nested/file"), "one");
    await symlink(at("nested"), at("linked"));
    await symlink(at("a.txt"), at("link.txt"));
    let reviews = 0;
    opts.select = async () => { reviews++; return [0]; };
    for (const name of ["../outside", at("a.txt"), "C:/absolute", "nested/../a.txt", "linked/file", "link.txt", ".git/config"]) {
      await assert.rejects(reviewTaskB(root, [{ ...hunks[0], path: name }], { [name]: "one" }, opts));
    }
    await writeFile(at("repeated.txt"), "aaaa");
    for (const original of ["aaa", "missing", ""]) {
      await assert.rejects(reviewTaskB(root, [{ path: "repeated.txt", original, replacement: "x" }], { "repeated.txt": "aaaa" }, opts));
    }
    await assert.rejects(reviewTaskB(root, hunks, { ...base, "a.txt": "old" }, opts));
    assert.equal(reviews, 0);
    assert.ok(decisions.every(value => !value));
  });

  test("dirty buffers are preserved and an intervening disk edit blocks an explicit save", async () => {
    const document = await doc("a.txt");
    await vscode.window.showTextDocument(document);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), "mine ");
    await vscode.workspace.applyEdit(edit);
    await assert.rejects(run());
    assert.equal(document.getText(), "mine one two three\n");
    await vscode.commands.executeCommand("undo");
    opts.confirmSave = async paths => {
      assert.deepEqual(paths, ["a.txt", "b.txt"]);
      await writeFile(at("a.txt"), "someone else's change\n");
      return true;
    };
    assert.equal((await run()).applied, true);
    assert.equal(await readFile(at("a.txt"), "utf8"), "someone else's change\n");
    assert.equal(document.isDirty, true);
  });
});
