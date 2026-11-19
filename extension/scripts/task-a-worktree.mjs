import {execFileSync} from "node:child_process";
import {statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

export function rehearsalRoot() {
  const root = path.resolve(process.env.FLASK_TASK_A_REPO ?? fileURLToPath(new URL("../../scratch/flask-task-a-agent", import.meta.url)));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {encoding: "utf8"}).trim();
  if (!statSync(path.join(root, ".git")).isFile() || git("rev-parse", "HEAD") !== "22d924701a6ae2e4cd01e9a15bbaf3946094af65" || git("status", "--porcelain")) {
    throw new Error("Point FLASK_TASK_A_REPO at a clean disposable worktree of the pinned Flask commit. The approved worktree can be verified with scripts/verify-task-a.sh.");
  }
  return root;
}
