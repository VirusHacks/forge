import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Staging } from "./staging";
import type { Workspace } from "./workspace";

/**
 * `run_command`: run a test or check against the workspace *with the staged edits applied*,
 * inside a disposable snapshot. The real workspace is never modified.
 *
 * Safety: no shell (argv only), an executable allowlist, a scrubbed environment without
 * credentials, a timeout and bounded output. On macOS the process additionally runs under
 * `sandbox-exec` with network access and writes outside the snapshot denied.
 */
export interface CommandResult { command: string; exitCode: number; ms: number; output: string; summary: string; timedOut: boolean; failures: string[] }

/** pytest node ids reported as FAILED/ERROR (used to separate new from pre-existing failures). */
export function failedTests(output: string): string[] {
  return [...new Set([...output.matchAll(/^(?:FAILED|ERROR) (\S+?)(?: - |$)/gm)].map(m => m[1]))];
}
export interface CommandOptions { allowed: string[]; python?: string; timeoutMs: number; sandbox: boolean; signal: AbortSignal }

export function tokenize(command: string): string[] {
  if (/[;&|<>`$\n\r]/.test(command.replace(/'[^']*'|"[^"]*"/g, ""))) throw new Error("Shell operators are not supported; run one command at a time.");
  const argv: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) argv.push(m[1] ?? m[2] ?? m[3]);
  if (!argv.length) throw new Error("Empty command.");
  return argv;
}

export class CommandRunner {
  private snapshotDir?: string;
  private snapshotDigest?: string;
  last?: CommandResult & { digest: string };

  constructor(private readonly ws: Workspace, private readonly staging: Staging, private readonly opts: Omit<CommandOptions, "signal">) {}

  private baselines = new Map<string, Promise<CommandResult>>();

  /** Run a command once on the *unmodified* workspace, cached per command. */
  baseline(command: string, signal: AbortSignal): Promise<CommandResult> {
    let p = this.baselines.get(command);
    if (!p) {
      p = new CommandRunner(this.ws, emptyStaging(), this.opts).run(command, signal).then(r => r, error => { this.baselines.delete(command); throw error; });
      this.baselines.set(command, p);
    }
    return p;
  }

  async run(command: string, signal: AbortSignal, timeoutMs = this.opts.timeoutMs): Promise<CommandResult> {
    const argv = tokenize(command);
    const exe = path.basename(argv[0]);
    if (!this.opts.allowed.includes(exe)) throw new Error(`"${exe}" is not in forge.allowedCommands (${this.opts.allowed.join(", ")}).`);
    const tree = this.snapshot();
    const resolved = this.resolve(exe);
    const tmp = mkdtempSync(path.join(os.tmpdir(), "forge-cmd-home-"));
    const bin = path.dirname(resolved);
    const env: NodeJS.ProcessEnv = {
      PATH: [bin, "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].join(":"),
      HOME: tmp, TMPDIR: tmp, LC_ALL: "C.UTF-8", LANG: "C.UTF-8", TERM: "dumb", NO_COLOR: "1",
      // Make the snapshot's sources win over any editable install that points at the real workspace.
      PYTHONPATH: [path.join(tree, "src"), tree].join(path.delimiter),
      PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", PYTEST_ADDOPTS: "-p no:cacheprovider",
    };
    let file = resolved, args = argv.slice(1);
    if (this.opts.sandbox && process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
      args = ["-p", SANDBOX_PROFILE, "-D", `TREE=${tree}`, "-D", `TMP=${tmp}`, file, ...args];
      file = "/usr/bin/sandbox-exec";
    }
    const t0 = Date.now();
    try {
      const result = await execute(file, args, tree, env, Math.min(timeoutMs, 300_000), signal);
      const output = clip(result.output.replace(new RegExp(escapeRegExp(tree), "g"), "<workspace>"), 3500);
      const summary = summarize(exe, argv, result.code, output, result.timedOut);
      const value = { command, exitCode: result.code, ms: Date.now() - t0, output, summary, timedOut: result.timedOut, failures: failedTests(result.output) };
      this.last = { ...value, digest: this.staging.digest() };
      return value;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  dispose() { if (this.snapshotDir) rmSync(this.snapshotDir, { recursive: true, force: true }); this.snapshotDir = undefined; }

  /** Copy workspace files plus staged contents into a private temp tree, reused until staging changes. */
  private snapshot(): string {
    const digest = this.staging.digest();
    if (this.snapshotDir && this.snapshotDigest === digest) return path.join(this.snapshotDir, "tree");
    this.dispose();
    const dir = mkdtempSync(path.join(os.tmpdir(), "forge-run-"));
    const tree = path.join(dir, "tree");
    for (const file of this.ws.snapshotFiles) {
      const target = path.join(tree, file);
      mkdirSync(path.dirname(target), { recursive: true });
      try { copyFileSync(path.join(this.ws.root, file), target); } catch { /* skip unreadable */ }
    }
    for (const staged of this.staging.snapshot()) {
      const target = path.join(tree, staged.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, staged.next);
    }
    this.snapshotDir = dir;
    this.snapshotDigest = digest;
    return tree;
  }

  private resolve(exe: string): string {
    const python = this.opts.python || ["/.venv/bin/python", "/venv/bin/python"].map(p => this.ws.root + p).find(existsSync);
    if (python) {
      if (exe === "python" || exe === "python3") return python;
      const sibling = path.join(path.dirname(python), exe);
      if (existsSync(sibling)) return sibling;
    }
    for (const dir of ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]) {
      const candidate = path.join(dir, exe);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`Cannot find "${exe}". Set forge.pythonPath to the project's Python interpreter.`);
  }
}

function emptyStaging(): Staging {
  return { digest: () => "baseline", snapshot: () => [] } as unknown as Staging;
}

const SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network*)
(allow network* (remote unix-socket))
(deny file-write*)
(allow file-write* (subpath (param "TREE")) (subpath (param "TMP")) (subpath "/private/var/folders") (subpath "/private/tmp") (literal "/dev/null") (literal "/dev/tty"))`;

function execute(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal) {
  return new Promise<{ code: number; output: string; timedOut: boolean }>((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: false });
    let output = "", timedOut = false;
    const take = (chunk: Buffer) => { output += chunk.toString("utf8"); if (output.length > 400_000) output = output.slice(-200_000); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      if (signal.aborted) return reject(new DOMException("Cancelled", "AbortError"));
      resolve({ code: code ?? -1, output, timedOut });
    });
  });
}

function summarize(exe: string, argv: string[], code: number, output: string, timedOut: boolean) {
  if (timedOut) return "timed out";
  const pytest = /=+\s*([^=\n]*\b(?:passed|failed|error|errors|no tests ran)\b[^=\n]*?)\s*=+\s*$/m.exec(output) ?? /^(\d+ (?:passed|failed)[^\n]*)$/m.exec(output);
  if (pytest) return pytest[1].trim();
  return `${[exe, ...argv.slice(1)].join(" ").slice(0, 60)} exited ${code}`;
}

/** Keep the head (command errors) and the tail (test summary) of long output. */
function clip(text: string, max: number) {
  if (text.length <= max) return text;
  return text.slice(0, Math.floor(max * 0.3)) + "\n… [output trimmed] …\n" + text.slice(-Math.floor(max * 0.7));
}
function escapeRegExp(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
