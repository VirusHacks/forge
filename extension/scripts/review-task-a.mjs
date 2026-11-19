import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rehearsalRoot } from "./task-a-worktree.mjs";

const root = rehearsalRoot();
const extension = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "forge-task-a-review-"));
if (!process.env.VSCODE_EXECUTABLE || !process.env.TRUEFORGE_MODEL) {
  throw new Error("Set VSCODE_EXECUTABLE and TRUEFORGE_MODEL before launching review.");
}
const child = spawn(process.env.VSCODE_EXECUTABLE, [
  root,
  "--extensionDevelopmentPath=" + extension, "--extensionTestsPath=" + path.join(extension, "scripts/task-a-review.cjs"),
  "--user-data-dir=" + profile, "--extensions-dir=" + path.join(profile, "extensions"),
  "--disable-extensions", "--skip-welcome", "--skip-release-notes",
], {
  stdio: "inherit",
  env: { ...process.env, FLASK_TASK_A_REPO: root, FORGE_REVIEW_PORT: "0" },
});
const [code] = await once(child, "exit");
process.exitCode = code ?? 1;
