import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isSensitivePath } from "../workspaceMcp";

/** A symbol from a cheap, language-agnostic outline (used for navigation and whole-symbol reads). */
export interface OutlineSymbol { name: string; kind: string; line: number; end: number; depth: number; text: string }

const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "out", ".tox", ".mypy_cache", ".pytest_cache", "target"]);
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|tgz|bz2|xz|whl|so|dylib|dll|exe|class|jar|pyc|woff2?|ttf|otf|mp[34]|mov|sqlite|db)$/i;

/**
 * The agent's view of a workspace: tracked/untracked-but-not-ignored text files under the
 * root, minus credentials, hidden directories and binaries. Works in any Git repository
 * (any commit, any branch) and falls back to a bounded directory walk outside Git.
 */
export class Workspace {
  /** Files the agent may read (text, non-sensitive, not hidden). */
  readonly files: string[];
  /** Files copied into command snapshots (also binaries and hidden config, never credentials). */
  readonly snapshotFiles: string[];
  readonly fileSet: Set<string>;
  readonly isGit: boolean;
  readonly maxReadLines = 200;
  private readonly cache = new Map<string, { mtimeMs: number; size: number; text: string }>();
  private readonly outlines = new Map<string, { text: string; symbols: OutlineSymbol[] }>();

  constructor(readonly root: string) {
    this.root = realpathSync(root);
    let listed: string[] | undefined;
    try {
      listed = execFileSync("git", ["-C", this.root, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 32_000_000 })
        .split("\0").filter(Boolean);
    } catch { /* not a Git repository */ }
    this.isGit = listed !== undefined;
    const all = listed ?? walk(this.root);
    this.files = all.filter(f => allowed(f)).sort();
    // Committed dotenv files are test fixtures (real secrets are untracked/ignored), so command
    // snapshots include them; the model can still never read them through a tool.
    let tracked = new Set<string>();
    try { tracked = new Set(execFileSync("git", ["-C", this.root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 32_000_000 }).split("\0").filter(Boolean)); } catch { /* not Git */ }
    const committedDotenv = (f: string) => tracked.has(f) && /(^|\/)\.(env|flaskenv)[^/]*$/.test(f) && !/\.(pem|key|p12|pfx)$/i.test(f);
    this.snapshotFiles = all.filter(f => !f.split("/").some(p => SKIP_DIRS.has(p)) && (!isSensitivePath(f) || committedDotenv(f)));
    this.fileSet = new Set(this.files);
  }

  has(file: string) { return this.fileSet.has(normalize(file)); }

  /** Current on-disk text. Throws for files outside the agent boundary. */
  source(file: string): string {
    const rel = normalize(file);
    if (!this.fileSet.has(rel)) throw new Error(`Not a readable workspace file: ${file}`);
    const abs = path.join(this.root, rel);
    if (realpathSync(abs) !== abs) throw new Error(`Symlinked files are not readable: ${file}`);
    const info = statSync(abs);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`Unsupported or oversized file: ${file}`);
    const cached = this.cache.get(rel);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.text;
    const text = readFileSync(abs, "utf8");
    if (text.includes("\0")) throw new Error(`Binary file: ${file}`);
    this.cache.set(rel, { mtimeMs: info.mtimeMs, size: info.size, text });
    return text;
  }

  tryLines(file: string): string[] | undefined {
    try { return this.source(file).split("\n"); } catch { return undefined; }
  }

  outline(file: string): OutlineSymbol[] {
    const text = this.source(file);
    const cached = this.outlines.get(file);
    if (cached?.text === text) return cached.symbols;
    const symbols = buildOutline(file, text.split("\n"));
    this.outlines.set(file, { text, symbols });
    return symbols;
  }

  /** Innermost symbol containing a 1-based line. */
  enclosing(file: string, line: number): OutlineSymbol | undefined {
    let best: OutlineSymbol | undefined;
    for (const s of this.outline(file)) if (s.line <= line && s.end >= line && (!best || s.depth >= best.depth)) best = s;
    return best;
  }

  /** Find a symbol by name or dotted path (e.g. "FlaskGroup.get_command"). */
  findSymbol(file: string, name: string): OutlineSymbol | undefined {
    const parts = name.split(".");
    const leaf = parts.at(-1)!;
    const candidates = this.outline(file).filter(s => s.name === leaf);
    if (parts.length === 1 || candidates.length <= 1) return candidates[0];
    const parent = parts.at(-2)!;
    return candidates.find(c => this.outline(file).some(p => p.name === parent && p.line < c.line && p.end >= c.end)) ?? candidates[0];
  }

  /** RepoMap compatibility: return `file:first\ntext` for a bounded range. */
  read(file: string, start: number | undefined, _anchor: string | undefined, count: number, _reason: string, charLimit = 6000): string {
    const lines = this.source(file).split("\n");
    const first = Math.max(1, start ?? 1);
    const block = lines.slice(first - 1, first - 1 + Math.min(count, this.maxReadLines)).join("\n").slice(0, charLimit);
    return `${file}:${first}\n${block}`;
  }
}

function normalize(file: string) { return file.replace(/\\/g, "/").replace(/^\.\//, ""); }

function allowed(file: string) {
  const parts = file.split("/");
  if (parts.some(p => SKIP_DIRS.has(p) || (p.startsWith(".") && p !== ".github"))) return false;
  return !isSensitivePath(file) && !BINARY_EXT.test(file);
}

function walk(root: string, limit = 5000): string[] {
  const out: string[] = [];
  const pending = [""];
  while (pending.length && out.length < limit) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) pending.push(rel); }
      else if (entry.isFile()) out.push(rel);
    }
  }
  return out;
}

const PATTERNS: { re: RegExp; kind: string }[] = [
  { re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: "class" },
  { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^(\s*)(?:export\s+)?(?:abstract\s+)?(?:class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^(\s*)(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: "function" },
  { re: /^(\s*)func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
  { re: /^(\s*)(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/, kind: "function" },
];

/** Indentation/brace-aware outline. Good enough for navigation; RepoMap supplies the graph. */
export function buildOutline(file: string, lines: string[]): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  if (/\.(rst|md|markdown|txt)$/i.test(file)) {
    for (let i = 0; i < lines.length; i++) {
      const md = /^(#{1,4})\s+(.+)/.exec(lines[i]);
      const rst = lines[i].trim() && /^\s*([=\-~^"`+*#])\1{2,}\s*$/.test(lines[i + 1] ?? "") && !/^\s*[=\-~^"`+*#]{3,}\s*$/.test(lines[i]);
      if (md || rst) symbols.push({ name: (md ? md[2] : lines[i]).trim().slice(0, 80), kind: "section", line: i + 1, end: lines.length, depth: md ? md[1].length : 1, text: lines[i].trim() });
    }
    for (let i = 0; i < symbols.length; i++) {
      const next = symbols.slice(i + 1).find(s => s.depth <= symbols[i].depth);
      symbols[i].end = next ? next.line - 1 : lines.length;
    }
    return symbols;
  }
  const python = /\.pyi?$/i.test(file);
  for (let i = 0; i < lines.length; i++) {
    for (const { re, kind } of PATTERNS) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const indent = m[1].replace(/\t/g, "    ").length;
      // Include decorators directly above Python definitions.
      let start = i;
      while (python && start > 0 && /^\s*@/.test(lines[start - 1])) start--;
      symbols.push({ name: m[2], kind, line: start + 1, end: python ? pythonEnd(lines, i, indent) : braceEnd(lines, i), depth: indent, text: lines[i].trim().slice(0, 140) });
      break;
    }
  }
  return symbols;
}

function pythonEnd(lines: string[], defLine: number, indent: number) {
  let last = defLine;
  // Skip a multi-line signature.
  let i = defLine;
  while (i < lines.length - 1 && !/:\s*(#.*)?$/.test(lines[i])) i++;
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const lead = line.match(/^\s*/)![0].replace(/\t/g, "    ").length;
    if (lead <= indent) break;
    last = i;
  }
  return last + 1;
}

function braceEnd(lines: string[], start: number) {
  let depth = 0, opened = false;
  for (let i = start; i < lines.length && i < start + 2000; i++) {
    for (const ch of lines[i].replace(/(["'`]).*?\1/g, "")) {
      if (ch === "{") { depth++; opened = true; } else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return i + 1;
    if (!opened && i > start + 3) return start + 1;
  }
  return start + 1;
}
