import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { suite, test } from "mocha";

import { checkTrueForge } from "../src/health";
import { ReviewController, type ReviewSurface } from "../src/review/reviewController";

/** A scripted reviewer standing in for the sidebar. */
function surface(pick: (hunks: number) => number[] | undefined, during?: () => Promise<void>): ReviewSurface & { results: unknown[] } {
  const results: unknown[] = [];
  return {
    results,
    reveal() { /* no view in tests */ },
    async requestReview(_run, request) { await during?.(); return pick(request.hunks.length); },
    reviewApplied(_run, outcome) { results.push(outcome); },
  };
}

const BASE = ["def a():", "    return 1", "", "", "def b():", "    return 2", "", "", "def c():", "    return 3", ""].join("\n");
const NEXT = BASE.replace("return 1", "return 10").replace("return 3", "return 30");

suite("Forge extension", () => {
  test("activates and registers its commands", async () => {
    const extension = vscode.extensions.getExtension("forge-a-thon.forge-a-thon-extension");
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["forge.inlineEdit", "forge.focus", "forge.stop", "forge.undoLastApply", "forge.environmentStatus"]) assert.ok(commands.includes(id), id);
  });

  test("reports an unreachable backend without throwing", async () => {
    assert.equal(await checkTrueForge("http://127.0.0.1:1"), "unreachable");
    assert.equal(await checkTrueForge(""), "not-configured");
  });

  test("applies only the accepted hunk, saves, and undoes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forge-review-"));
    try {
      const file = path.join(root, "m.py");
      await writeFile(file, BASE);
      const s = surface(() => [1]);
      const reviews = new ReviewController(s);
      const outcome = await reviews.review("run", root, { title: "t", files: [{ path: "m.py", base: BASE, next: NEXT }] }, new AbortController().signal);
      assert.deepEqual(outcome, { applied: true, selected: [1], files: ["m.py"] });
      const applied = await readFile(file, "utf8");
      assert.ok(applied.includes("return 30") && applied.includes("return 1\n"), "only the second hunk is applied and saved");
      assert.match(await reviews.undoLast(), /Restored 1 file/);
      assert.equal(await readFile(file, "utf8"), BASE);
      reviews.dispose();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejecting writes nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forge-review-"));
    try {
      const file = path.join(root, "m.py");
      await writeFile(file, BASE);
      const reviews = new ReviewController(surface(() => undefined));
      const outcome = await reviews.review("run", root, { title: "t", files: [{ path: "m.py", base: BASE, next: NEXT }] }, new AbortController().signal);
      assert.equal(outcome.applied, false);
      assert.equal(await readFile(file, "utf8"), BASE);
      reviews.dispose();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("refuses to apply when the file changed during review", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forge-review-"));
    try {
      const file = path.join(root, "m.py");
      await writeFile(file, BASE);
      const reviews = new ReviewController(surface(() => [0, 1], () => writeFile(file, BASE + "# edited by the user\n")));
      await assert.rejects(reviews.review("run", root, { title: "t", files: [{ path: "m.py", base: BASE, next: NEXT }] }, new AbortController().signal), /changed after the proposal/);
      assert.equal(await readFile(file, "utf8"), BASE + "# edited by the user\n");
      reviews.dispose();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("creates a new file and undo removes it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forge-review-"));
    try {
      const reviews = new ReviewController(surface(n => [...Array(n).keys()]));
      const outcome = await reviews.review("run", root, { title: "t", files: [{ path: "pkg/new.py", base: null, next: "x = 1\n" }] }, new AbortController().signal);
      assert.equal(outcome.applied, true);
      assert.equal(await readFile(path.join(root, "pkg/new.py"), "utf8"), "x = 1\n");
      await reviews.undoLast();
      await assert.rejects(readFile(path.join(root, "pkg/new.py"), "utf8"));
      reviews.dispose();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("cancellation during review writes nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forge-review-"));
    try {
      const file = path.join(root, "m.py");
      await writeFile(file, BASE);
      const controller = new AbortController();
      const reviews = new ReviewController(surface(() => [0, 1], async () => controller.abort()));
      const outcome = await reviews.review("run", root, { title: "t", files: [{ path: "m.py", base: BASE, next: NEXT }] }, controller.signal);
      assert.equal(outcome.applied, false);
      assert.equal(await readFile(file, "utf8"), BASE);
      reviews.dispose();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
