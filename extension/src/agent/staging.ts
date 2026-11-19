import { createHash } from "node:crypto";
import { diffLines, hunkPreview, type LineHunk } from "../core/diff";
import type { Workspace } from "./workspace";

/**
 * In-memory staging of proposed edits. Nothing here touches the workspace on disk.
 *
 * An edit replaces one exact, unique occurrence of `find` in the file's *staged* text,
 * so successive edits compose. To keep weak models productive, near-misses are repaired
 * when they are unambiguous (trailing whitespace, CRLF, or a uniform indentation shift),
 * and failures return the closest real lines so the model can retry once with the
 * correct anchor instead of re-reading the file.
 */
export interface Edit { path: string; find: string; replace: string }
export interface EditResult { path: string; status: "applied" | "repaired" | "created" | "failed"; line?: number; message?: string }
export interface StagedFile { path: string; base: string | null; next: string }
export interface ReviewHunk extends LineHunk { index: number; path: string; newFile: boolean }

const MAX_FILES = 20;

export class Staging {
  private readonly files = new Map<string, StagedFile>();
  constructor(private readonly ws: Workspace) {}

  get isEmpty() { return ![...this.files.values()].some(f => f.base !== f.next); }
  get paths() { return [...this.files.values()].filter(f => f.base !== f.next).map(f => f.path); }
  snapshot(): StagedFile[] { return [...this.files.values()].filter(f => f.base !== f.next).map(f => ({ ...f })); }

  digest(): string {
    const h = createHash("sha256");
    for (const f of this.snapshot().sort((a, b) => a.path.localeCompare(b.path))) h.update(f.path).update("\0").update(f.next).update("\0");
    return h.digest("hex").slice(0, 16);
  }

  stage(edits: Edit[]): EditResult[] {
    return edits.map(edit => {
      try { return this.stageOne(edit); }
      catch (error) { return { path: edit.path, status: "failed", message: (error as Error).message }; }
    });
  }

  discard(path?: string) { if (path) this.files.delete(path); else this.files.clear(); }

  private stageOne(edit: Edit): EditResult {
    const file = edit.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!file || file.startsWith("/") || file.split("/").includes("..")) throw new Error("Use a workspace-relative path.");
    let staged = this.files.get(file);
    if (!staged) {
      if (this.ws.has(file)) staged = { path: file, base: this.ws.source(file), next: this.ws.source(file) };
      else {
        if (edit.find.trim()) throw new Error(`${file} does not exist. To create a new file use an empty "find".`);
        if (this.files.size >= MAX_FILES) throw new Error("Too many files staged.");
        this.files.set(file, { path: file, base: null, next: ensureNewline(edit.replace) });
        return { path: file, status: "created", line: 1 };
      }
      if (this.files.size >= MAX_FILES) throw new Error("Too many files staged.");
      this.files.set(file, staged);
    }
    if (!edit.find) {
      if (staged.base === null) { staged.next = ensureNewline(edit.replace); return { path: file, status: "created", line: 1 }; }
      throw new Error(`"find" is empty. Copy the exact existing lines to replace in ${file}.`);
    }
    const text = staged.next;
    // Duplicate-insertion guard: models often re-send an insertion they already staged.
    const inserted = insertedText(edit.find, edit.replace);
    if (inserted && inserted.trim().length >= 12 && text.includes(inserted.trim())) {
      return { path: file, status: "applied", line: lineAt(text, text.indexOf(inserted.trim())), message: "already staged; skipped to avoid a duplicate" };
    }
    const exact = occurrences(text, edit.find);
    if (exact.length === 1) {
      staged.next = text.slice(0, exact[0]) + edit.replace + text.slice(exact[0] + edit.find.length);
      return { path: file, status: "applied", line: lineAt(text, exact[0]) };
    }
    if (exact.length > 1) {
      throw new Error(`"find" occurs ${exact.length} times in ${file} (lines ${exact.slice(0, 5).map(o => lineAt(text, o)).join(", ")}). Include more surrounding lines to make it unique.`);
    }
    const repaired = fuzzyLocate(text, edit.find);
    if (repaired.kind === "unique") {
      const replacement = reindent(edit.replace, repaired.indentDelta);
      staged.next = text.slice(0, repaired.start) + replacement + text.slice(repaired.end);
      return { path: file, status: "repaired", line: lineAt(text, repaired.start), message: "matched after normalising whitespace/indentation" };
    }
    if (repaired.kind === "ambiguous") throw new Error(`"find" matches ${repaired.count} places in ${file} after ignoring whitespace. Include more surrounding lines.`);
    throw new Error(`"find" text not found in ${file}.${closestHint(text, edit.find)}`);
  }

  /** Line-level hunks for review, in file order. */
  hunks(): ReviewHunk[] {
    const out: ReviewHunk[] = [];
    for (const f of this.snapshot().sort((a, b) => a.path.localeCompare(b.path))) {
      for (const h of diffLines(f.base ?? "", f.next)) out.push({ ...h, index: out.length, path: f.path, newFile: f.base === null });
    }
    return out;
  }

  /** Compact diff for tool responses (bounded). */
  diffText(maxChars = 3500): string {
    const parts = this.hunks().map(h => `@@ ${h.path}:${h.startLine + 1} @@\n${hunkPreview(h, 30)}`);
    const text = parts.join("\n");
    return text.length > maxChars ? text.slice(0, maxChars) + "\n… (diff truncated)" : text || "(nothing staged)";
  }
}

/** For pure insertions (replace = find plus new text before or after it) return the new text. */
function insertedText(find: string, replace: string): string | undefined {
  if (!find || replace.length <= find.length) return undefined;
  if (replace.startsWith(find)) return replace.slice(find.length);
  if (replace.endsWith(find)) return replace.slice(0, replace.length - find.length);
  return undefined;
}

function ensureNewline(text: string) { return text.endsWith("\n") ? text : text + "\n"; }
function lineAt(text: string, offset: number) { let n = 1; for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++; return n; }
function occurrences(text: string, needle: string) {
  const out: number[] = [];
  for (let at = text.indexOf(needle); at >= 0 && out.length < 20; at = text.indexOf(needle, at + 1)) out.push(at);
  return out;
}

type Located = { kind: "unique"; start: number; end: number; indentDelta: number } | { kind: "ambiguous"; count: number } | { kind: "none" };

/** Match line-by-line ignoring trailing whitespace and a uniform indentation offset. */
function fuzzyLocate(text: string, find: string): Located {
  const lines = text.split("\n");
  const want = find.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  while (want.length && !want[0].trim()) want.shift();
  if (!want.length) return { kind: "none" };
  const norm = (s: string) => s.replace(/\s+$/, "");
  const lead = (s: string) => s.match(/^[ \t]*/)![0].replace(/\t/g, "    ").length;
  const firstNonBlank = want.find(l => l.trim())!;
  const matches: { start: number; delta: number }[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let delta: number | undefined, ok = true;
    for (let j = 0; j < want.length && ok; j++) {
      const have = lines[i + j], need = want[j];
      if (!need.trim()) { ok = !have.trim(); continue; }
      if (norm(have).trimStart() !== norm(need).trimStart()) { ok = false; break; }
      const d = lead(have) - lead(need);
      if (delta === undefined) delta = d; else if (d !== delta) ok = false;
    }
    if (ok) matches.push({ start: i, delta: delta ?? lead(lines[i]) - lead(firstNonBlank) });
  }
  if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
  if (!matches.length) return { kind: "none" };
  const { start, delta } = matches[0];
  const startOffset = lines.slice(0, start).join("\n").length + (start ? 1 : 0);
  const endLine = start + want.length;
  const trailingNewline = /\n$/.test(find);
  const endOffset = lines.slice(0, endLine).join("\n").length + (trailingNewline && endLine < lines.length ? 1 : 0);
  return { kind: "unique", start: startOffset, end: endOffset, indentDelta: delta };
}

function reindent(text: string, delta: number) {
  if (!delta) return text;
  return text.split("\n").map(line => {
    if (!line.trim()) return line;
    if (delta > 0) return " ".repeat(delta) + line;
    const strip = Math.min(-delta, line.match(/^ */)![0].length);
    return line.slice(strip);
  }).join("\n");
}

/** Show the real lines nearest to the first line of a failed anchor, without revealing unrelated code. */
function closestHint(text: string, find: string): string {
  const first = find.split("\n").find(l => l.trim())?.trim();
  if (!first || first.length < 4) return " Copy the exact lines from a read_code result.";
  const lines = text.split("\n");
  const tokens = first.split(/\W+/).filter(t => t.length > 2);
  let best = -1, bestScore = 0;
  lines.forEach((line, i) => {
    const score = tokens.filter(t => line.includes(t)).length / Math.max(1, tokens.length);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  if (best < 0 || bestScore < 0.5) return " Copy the exact lines from a read_code result.";
  const from = Math.max(0, best - 1), to = Math.min(lines.length, best + 4);
  return ` Closest existing lines (${from + 1}-${to}):\n${lines.slice(from, to).join("\n")}`;
}
