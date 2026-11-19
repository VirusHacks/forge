import { spawn } from "node:child_process";
import path from "node:path";

type Result = { ok: boolean; summary: string };
const project = path.resolve(__dirname, "../../..");
const cancelled = (): Result => ({ ok: false, summary: "Task B verification cancelled." });

export async function validateTaskB(
  root: string,
  files: Record<string, string>,
  signal?: AbortSignal,
): Promise<Result> {
  if (signal?.aborted) return cancelled();
  if (process.platform !== "darwin") {
    return { ok: false, summary: "Task B verification requires macOS sandbox-exec." };
  }

  // Only this trusted driver runs outside Seatbelt. Proposal data never becomes argv or env.
  const input = JSON.stringify({ root, files });
  const python = path.join(project, "scratch/flask-task-a-agent-venv/bin/python");
  const driver = path.join(project, "scripts/task-b-check.py");
  return new Promise((resolve) => {
    const child = spawn(python, ["-I", "-S", "-B", driver], {
      cwd: project,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const stop = () => { child.kill("SIGTERM"); };
    signal?.addEventListener("abort", stop, { once: true });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    // The driver may exit before reading stdin (missing runtime, cancellation).
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", () => resolve({ ok: false, summary: "Could not launch the Task B verifier in its venv." }));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return resolve(cancelled());
      // The driver emits only a bounded, trusted summary. Child stdout stays in the sandbox checks.
      resolve({
        ok: code === 0 && Boolean(output.trim()),
        summary: output.trim() || "Task B verifier exited without a result.",
      });
    });
  });
}
