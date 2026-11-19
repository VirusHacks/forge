import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { UiEvent } from "../core/events";
import type { RepoMapIndex } from "../repoMap";
import { CommandRunner } from "./commands";
import { estimateTokens, roleOf } from "./retrieval";
import { Staging } from "./staging";
import type { Workspace } from "./workspace";

/**
 * MCP tools exposed to the TrueForge agent. The agent decides what to read, edit and run;
 * the extension only executes bounded, auditable operations:
 *
 *   search_code   several literal queries in one call, hits labelled with their enclosing symbol
 *   read_code     several whole symbols or line ranges in one call
 *   find_symbol   RepoMap definition + static callers/callees/tests        (deferred)
 *   list_files    tracked files under a directory                          (deferred)
 *   stage_edits   exact find/replace edits staged in memory (never on disk)
 *   view_staged / discard_staged                                           (deferred)
 *   run_command   allowlisted command in a disposable snapshot with staged edits applied
 *   submit_for_review   approval-gated in TrueForge; drives the per-hunk diff review
 */
export const AGENT_TOOLS = ["search_code", "read_code", "find_symbol", "list_files", "stage_edits", "view_staged", "discard_staged", "run_command", "submit_for_review"];
export const PRELOADED_TOOLS = ["search_code", "read_code", "stage_edits", "run_command", "submit_for_review"];
export const APPROVAL_TOOLS = ["submit_for_review"];

export interface ToolSettings {
  maxResultChars: number; allowedCommands: string[]; python?: string; commandTimeoutMs: number; sandboxCommands: boolean;
  /** Run the relevant tests automatically after every successful stage_edits (no extra model call). */
  autoVerify?: boolean;
  /** Optional verification command template; `{tests}` is replaced by the inferred test files. */
  verifyCommand?: string;
}

const safe = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const readItem = z.object({ path: z.string().min(1).max(400), symbol: z.string().max(200).optional(), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() });
const editItem = z.object({ path: z.string().min(1).max(400), find: z.string().max(12000), replace: z.string().max(40000) });

export class AgentTools {
  readonly staging: Staging;
  readonly commands: CommandRunner;
  readonly counts: Record<string, number> = {};
  /** Set by the review flow before TrueForge executes the approved submit_for_review call. */
  reviewOutcome?: string;
  /** Model calls used/allowed, appended to results so models plan within the budget. */
  callBudget?: () => { used: number; max: number };
  private readonly shown = new Map<string, string>();

  constructor(private readonly ws: Workspace, private readonly repomap: RepoMapIndex | undefined, private readonly settings: ToolSettings,
    private readonly emit: (e: UiEvent) => void, private readonly signal: AbortSignal) {
    this.staging = new Staging(ws);
    this.commands = new CommandRunner(ws, this.staging, { allowed: settings.allowedCommands, python: settings.python, timeoutMs: settings.commandTimeoutMs, sandbox: settings.sandboxCommands });
  }

  get totalCalls() { return Object.values(this.counts).reduce((a, b) => a + b, 0); }

  /** Context was compacted by TrueForge: earlier reads may be gone, so allow re-reading. */
  forgetShown() { this.shown.clear(); }

  dispose() { this.commands.dispose(); }

  /** Run a tool body with Forge's accounting, UI events and error handling. */
  wrap(name: string, title: string, fn: () => unknown | Promise<unknown>) { return this.call(name, title, undefined, fn); }

  createServer(extend?: (server: McpServer) => void): McpServer {
    const m = new McpServer({ name: "forge-agent-tools", version: "2.0.0" });
    extend?.(m);

    m.registerTool("search_code", {
      description: "Search workspace files for several literal strings at once (case-insensitive). Returns path:line: text [enclosing symbol]. Put all queries in one call.",
      inputSchema: { queries: z.array(z.string().min(2).max(120)).max(6).optional(), query: z.string().min(2).max(120).optional(), path_filter: z.string().max(200).optional() }, annotations: safe,
    }, args => {
      // Accept a single `query` too: small models often drop the array wrapper.
      const queries = [...(args.queries ?? []), ...(args.query ? [args.query] : [])].slice(0, 6);
      return this.call("search_code", `Search ${queries.map(q => `"${q}"`).join(", ")}`, args.path_filter, () => {
        if (!queries.length) throw new Error("Provide queries: [\"...\"].");
        return this.search(queries, args.path_filter);
      });
    });

    m.registerTool("read_code", {
      description: "Read several code regions in one call. Each item: path plus symbol (function/class name, dotted for methods) or start_line/end_line. Omit both for the file outline and head. Max 200 lines per item.",
      inputSchema: { items: z.array(readItem).max(6).optional(), ...readItem.partial().shape },
      annotations: safe,
    }, args => {
      const items = [...(args.items ?? []), ...(args.path ? [{ path: args.path, symbol: args.symbol, start_line: args.start_line, end_line: args.end_line }] : [])].slice(0, 6);
      const prepare = () => this.parseOutlines(items.map(i => i.path.replace(/^\.\//, "")));
      return this.call("read_code", `Read ${items.map(i => `${i.path.split("/").pop()}${i.symbol ? ":" + i.symbol : i.start_line ? `:${i.start_line}-${i.end_line ?? ""}` : ""}`).join(", ")}`, undefined, () => {
        if (!items.length) throw new Error("Provide items: [{path, symbol | start_line, end_line}].");
        return prepare().then(() => this.read(items));
      });
    });

    m.registerTool("find_symbol", {
      description: "Locate a symbol with the RepoMap code graph: definition, signature, statically inferred callers/callees and related tests.",
      inputSchema: { name: z.string().min(2).max(160) }, annotations: safe,
    }, args => this.call("find_symbol", `Graph lookup ${args.name}`, undefined, () => this.findSymbol(args.name)));

    m.registerTool("list_files", {
      description: "List workspace files under a directory, optionally filtered by a substring.",
      inputSchema: { dir: z.string().max(300).optional(), contains: z.string().max(100).optional() }, annotations: safe,
    }, args => this.call("list_files", `List ${args.dir || "."}${args.contains ? ` *${args.contains}*` : ""}`, undefined, () => this.list(args.dir, args.contains)));

    m.registerTool("stage_edits", {
      description: "Stage edits in memory (nothing is written to disk). Each edit replaces one exact, unique occurrence of `find` (copy complete existing lines) with `replace`. Empty `find` creates a new file. Send all edits in one call.",
      inputSchema: { edits: z.array(editItem).max(12).optional(), ...editItem.partial().shape },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, args => {
      const edits = [...(args.edits ?? []), ...(args.path && args.replace !== undefined ? [{ path: args.path, find: args.find ?? "", replace: args.replace }] : [])];
      return this.call("stage_edits", `Stage ${edits.length} edit${edits.length === 1 ? "" : "s"} in ${[...new Set(edits.map(e => e.path))].join(", ")}`, undefined, () => {
        if (!edits.length) throw new Error("Provide edits: [{path, find, replace}].");
        return this.stage(edits);
      });
    });

    m.registerTool("view_staged", { description: "Show the staged changes as a diff.", inputSchema: {}, annotations: safe },
      () => this.call("view_staged", "View staged diff", undefined, () => this.staging.diffText(this.settings.maxResultChars)));

    m.registerTool("discard_staged", { description: "Discard staged changes for one path, or all when path is omitted.", inputSchema: { path: z.string().max(400).optional() }, annotations: safe },
      args => this.call("discard_staged", `Discard ${args.path ?? "all staged edits"}`, undefined, () => { this.staging.discard(args.path); return "Discarded."; }));

    m.registerTool("run_command", {
      description: "Run one allowlisted command (e.g. `python -m pytest tests/test_x.py -q`) in a disposable copy of the workspace with staged edits applied. No shell operators.",
      inputSchema: { command: z.string().min(1).max(500), timeout_seconds: z.number().int().min(5).max(300).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, args => this.call("run_command", `Run ${args.command}`, undefined, async () => {
      const r = await this.commands.run(args.command, this.signal, args.timeout_seconds ? args.timeout_seconds * 1000 : undefined);
      return { text: `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""} · ${r.summary} · ${r.ms} ms\n${r.output}`, summary: `${r.exitCode === 0 ? "✓" : "✗"} ${r.summary}`, ok: r.exitCode === 0 };
    }));

    m.registerTool("submit_for_review", {
      description: "Ask the user to review the staged changes hunk by hunk. Call once after verification. Requires approval; the result reports what the user accepted.",
      inputSchema: { summary: z.string().min(1).max(2000) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, args => this.call("submit_for_review", "Submit for review", undefined, () => this.reviewOutcome ?? `Review requested: ${args.summary.slice(0, 200)}`));

    return m;
  }

  private async call(name: string, title: string, detail: string | undefined,
    fn: () => unknown | Promise<unknown>) {
    this.signal.throwIfAborted();
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    const id = randomUUID();
    const t0 = Date.now();
    this.emit({ type: "tool.start", id, name, title, detail });
    try {
      const value = await fn();
      const result = typeof value === "string" ? { text: value, summary: firstLine(value), ok: true } : value as { text: string; summary: string; ok: boolean };
      const text = bound(result.text, this.settings.maxResultChars) + this.budgetNote();
      this.emit({ type: "tool.end", id, ok: result.ok, ms: Date.now() - t0, summary: result.summary, preview: text.slice(0, 2500) });
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      if (this.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "tool.end", id, ok: false, ms: Date.now() - t0, summary: message.slice(0, 200), preview: message.slice(0, 1500) });
      return { isError: true, content: [{ type: "text" as const, text: bound(message, 2000) }] };
    }
  }

  /** Ask RepoMap for exact AST symbol ranges before resolving symbols (falls back to patterns). */
  private async parseOutlines(files: string[]) {
    if (!this.repomap) return;
    for (const file of new Set(files)) {
      if (!this.ws.has(file) || this.ws.hasParsedOutline(file)) continue;
      try { this.ws.setParsedOutline(file, await this.repomap.members(file, this.signal)); } catch { /* pattern outline */ }
    }
  }

  private budgetNote() {
    const b = this.callBudget?.();
    if (!b || b.used < b.max / 3) return "";
    const left = b.max - b.used;
    if (left <= 4) {
      return this.staging.isEmpty
        ? `\n[Forge: only ${left} model calls left. Stage all your edits in your NEXT call; do not read more.]`
        : `\n[Forge: only ${left} model calls left. Call submit_for_review now (fix a failing test first only if it takes one stage_edits call).]`;
    }
    return `\n[Forge: ${b.used}/${b.max} model calls used.${left <= b.max / 3 ? " Stage your edits now, then submit_for_review." : " Batch remaining reads into one call."}]`;
  }

  private search(queries: string[], filter?: string): { text: string; summary: string; ok: boolean } {
    const result = this.searchOnce(queries, filter);
    // A path filter that hides every match wastes a model call: show the unfiltered hits instead.
    if (filter && result.hits === 0) {
      const wide = this.searchOnce(queries);
      if (wide.hits) return { text: `No matches under "${filter}". Matches elsewhere:\n${wide.text}`, summary: `0 in filter · ${wide.hits} elsewhere`, ok: true };
    }
    return result;
  }

  private searchOnce(queries: string[], filter?: string) {
    const out: string[] = [];
    let hits = 0;
    for (const query of queries) {
      const needle = query.toLowerCase();
      const rows: { score: number; row: string }[] = [];
      for (const file of this.ws.files) {
        if (filter && !file.includes(filter.replace(/^\*+|\*+$/g, ""))) continue;
        const lines = this.ws.tryLines(file);
        if (!lines) continue;
        for (let i = 0; i < lines.length && rows.length < 400; i++) {
          if (!lines[i].toLowerCase().includes(needle)) continue;
          const def = /^\s*(?:@|(?:async\s+)?def |class |function |export |func |fn )/.test(lines[i]) ? 3 : 0;
          const symbol = this.ws.enclosing(file, i + 1);
          rows.push({ score: def + (file.toLowerCase().includes(needle) ? 1 : 0) - file.split("/").length * 0.05,
            row: `${file}:${i + 1}: ${lines[i].trim().slice(0, 160)}${symbol ? `  [${symbol.name}]` : ""}` });
        }
      }
      rows.sort((a, b) => b.score - a.score);
      hits += rows.length;
      out.push(`## "${query}" — ${rows.length ? `${rows.length} hit${rows.length === 1 ? "" : "s"}` : "no matches"}`, ...rows.slice(0, 10).map(r => r.row));
      if (rows.length > 10) out.push(`… ${rows.length - 10} more (narrow the query or use path_filter)`);
    }
    return { text: out.join("\n"), summary: `${hits} hits for ${queries.length} quer${queries.length === 1 ? "y" : "ies"}`, ok: true, hits };
  }

  private read(items: { path: string; symbol?: string; start_line?: number; end_line?: number }[]) {
    const out: string[] = [];
    let budget = this.settings.maxResultChars - 200;
    const done: string[] = [];
    for (const item of items) {
      const file = item.path.replace(/^\.\//, "");
      if (!this.ws.has(file)) { out.push(`### ${file}\nNot a readable workspace file.${this.suggest(file)}`); continue; }
      const lines = this.ws.source(file).split("\n");
      let start: number, end: number, label = "";
      if (item.symbol) {
        const sym = this.ws.findSymbol(file, item.symbol);
        if (!sym) { out.push(`### ${file}\nSymbol "${item.symbol}" not found. Outline:\n${this.outline(file)}`); continue; }
        start = sym.line; end = Math.min(sym.end, sym.line + this.ws.maxReadLines - 1); label = ` (${sym.name})`;
      } else if (item.start_line) {
        start = Math.min(item.start_line, lines.length); end = Math.min(lines.length, item.end_line ?? start + 79, start + this.ws.maxReadLines - 1);
      } else {
        out.push(`### ${file} outline (${lines.length} lines)\n${this.outline(file)}`);
        start = 1; end = Math.min(lines.length, 60);
      }
      const key = `${file}:${start}-${end}`;
      const text = lines.slice(start - 1, end).join("\n");
      if (this.shown.get(key) === text) { out.push(`### ${file} lines ${start}-${end}${label}\n(unchanged; already shown earlier in this session)`); continue; }
      let block = `### ${file} lines ${start}-${end}${label}\n\`\`\`\n${text}\n\`\`\``;
      if (block.length > budget) {
        const keep = Math.max(10, Math.floor((budget / Math.max(1, block.length)) * (end - start + 1)) - 2);
        end = start + keep - 1;
        block = `### ${file} lines ${start}-${end}${label} (truncated; read from line ${end + 1} for more)\n\`\`\`\n${lines.slice(start - 1, end).join("\n")}\n\`\`\``;
      }
      if (budget <= 200) { out.push(`### ${file}\n(skipped: result size limit; request it in a separate call)`); continue; }
      this.shown.set(`${file}:${start}-${end}`, lines.slice(start - 1, end).join("\n"));
      out.push(block);
      budget -= block.length;
      done.push(`${file.split("/").pop()}:${start}-${end}`);
    }
    return { text: out.join("\n\n"), summary: `${done.length} region${done.length === 1 ? "" : "s"} · ~${estimateTokens(out.join(""))} tokens`, ok: true };
  }

  private outline(file: string) {
    return this.ws.outline(file).filter(s => s.depth <= 8).slice(0, 60).map(s => `L${s.line}-${s.end} ${s.text}`).join("\n") || "(no symbols detected)";
  }

  private suggest(file: string) {
    const name = file.split("/").pop()!.toLowerCase();
    const similar = this.ws.files.filter(f => f.toLowerCase().endsWith(name) || f.toLowerCase().includes(name.replace(/\.\w+$/, ""))).slice(0, 5);
    return similar.length ? ` Did you mean: ${similar.join(", ")}?` : "";
  }

  private async findSymbol(name: string) {
    if (this.repomap) {
      try {
        const found = await this.repomap.find(name, this.signal);
        const hits = found.hits.slice(0, 5);
        if (hits.length) {
          const ctx = await this.repomap.context(hits[0].id, this.signal);
          const rows = [
            ...hits.map((h: any) => `definition: ${h.name} (${h.kind}) ${h.file}:${h.line}${h.end ? "-" + h.end : ""}`),
            ctx.signature ? `signature: ${ctx.signature}` : "",
            ...ctx.callers.map((c: any) => `caller: ${c.symbol.name} ${c.siteFile}:${c.at ?? c.symbol.line}${c.sourceLine ? "  " + c.sourceLine.trim() : ""}`),
            ...ctx.callees.map((c: any) => `callee: ${c.symbol.name} ${c.symbol.file}:${c.symbol.line}`),
            ...ctx.tests.map((t: string) => `test file: ${t}`),
            "(graph edges are statically inferred; verify in source)",
          ].filter(Boolean);
          return { text: rows.join("\n"), summary: `${hits[0].name} · ${ctx.callers.length} callers · ${ctx.tests.length} tests`, ok: true };
        }
      } catch { /* fall back to the outline index */ }
    }
    const leaf = name.split(".").pop()!;
    const rows: string[] = [];
    for (const file of this.ws.files) {
      for (const s of (() => { try { return this.ws.outline(file); } catch { return []; } })()) if (s.name === leaf) rows.push(`definition: ${s.name} (${s.kind}) ${file}:${s.line}-${s.end}`);
      if (rows.length >= 8) break;
    }
    return { text: rows.join("\n") || `No definition named ${name}.`, summary: `${rows.length} definition${rows.length === 1 ? "" : "s"} (outline index)`, ok: rows.length > 0 };
  }

  private list(dir = "", contains?: string) {
    const prefix = dir.replace(/^\.?\/?/, "").replace(/\/?$/, dir ? "/" : "");
    const rows = this.ws.files.filter(f => f.startsWith(prefix) && (!contains || f.toLowerCase().includes(contains.toLowerCase())));
    return { text: rows.slice(0, 80).join("\n") + (rows.length > 80 ? `\n… ${rows.length - 80} more` : "") || "No files.", summary: `${rows.length} files`, ok: true };
  }

  private async stage(edits: { path: string; find: string; replace: string }[]) {
    const results = this.staging.stage(edits);
    const failed = results.filter(r => r.status === "failed");
    const lines = results.map(r => `${r.status.toUpperCase()} ${r.path}${r.line ? ":" + r.line : ""}${r.message ? " — " + r.message : ""}`);
    const hunks = this.staging.hunks();
    lines.push(`Staged now: ${hunks.length} hunk${hunks.length === 1 ? "" : "s"} in ${this.staging.paths.length} file${this.staging.paths.length === 1 ? "" : "s"} (${this.staging.paths.join(", ") || "none"}).`);
    let verified: { ok: boolean; line: string } | undefined;
    if (!failed.length) verified = await this.autoVerify();
    if (failed.length) lines.push("Fix only the FAILED edits (copy exact lines), then continue.");
    else if (verified) lines.push(verified.line, verified.ok ? "Tests pass. Next: call submit_for_review." : "Fix the failing test or code with stage_edits (verification re-runs automatically), then submit_for_review.");
    else lines.push("Next: verify with run_command, then call submit_for_review.");
    return { text: lines.join("\n"), summary: failed.length ? `${results.length - failed.length}/${results.length} staged, ${failed.length} failed` : `${results.length} staged · ${hunks.length} hunks${verified ? (verified.ok ? " · tests ✓" : " · tests ✗") : ""}`, ok: failed.length === 0 };
  }

  /** Tests to run for the staged change: staged test files plus tests named after staged modules. */
  inferVerifyCommand(): string | undefined {
    const staged = this.staging.paths;
    const tests = new Set(staged.filter(p => roleOf(p) === "test" && /\.py$/.test(p)));
    for (const p of staged) {
      if (roleOf(p) !== "implementation" || !p.endsWith(".py")) continue;
      const stem = p.split("/").pop()!.replace(/\.py$/, "");
      for (const f of this.ws.files) if (roleOf(f) === "test" && f.split("/").pop() === `test_${stem}.py`) tests.add(f);
    }
    const list = [...tests].slice(0, 4).join(" ");
    if (this.settings.verifyCommand) return this.settings.verifyCommand.replace("{tests}", list).trim() || undefined;
    if (!list || !this.settings.allowedCommands.includes("python")) return undefined;
    return `python -m pytest ${list} -q --no-header`;
  }

  /** Harness-side verification: runs without spending a model call and feeds the review badge. */
  private async autoVerify(): Promise<{ ok: boolean; line: string } | undefined> {
    if (!this.settings.autoVerify) return undefined;
    const command = this.inferVerifyCommand();
    if (!command || this.commands.last?.digest === this.staging.digest()) return undefined;
    const id = randomUUID(), t0 = Date.now();
    this.emit({ type: "tool.start", id, name: "run_command", title: `Auto-verify · ${command}` });
    try {
      const [r, base] = await Promise.all([this.commands.run(command, this.signal), this.commands.baseline(command, this.signal).catch(() => undefined)]);
      // Only failures that the staged change introduced count; pre-existing ones are reported separately.
      const preexisting = base ? r.failures.filter(f => base.failures.includes(f)) : [];
      const introduced = r.failures.filter(f => !preexisting.includes(f));
      const ok = r.exitCode === 0 || (r.failures.length > 0 && introduced.length === 0);
      const note = preexisting.length ? ` (${preexisting.length} failure${preexisting.length === 1 ? "" : "s"} also fail without your change: ${preexisting.join(", ")})` : "";
      if (ok && r.exitCode !== 0 && this.commands.last) this.commands.last = { ...this.commands.last, exitCode: 0, summary: `${r.summary}; no new failures` };
      this.emit({ type: "tool.end", id, ok, ms: Date.now() - t0, summary: `${ok ? "✓" : "✗"} ${r.summary}${preexisting.length ? ` · ${preexisting.length} pre-existing` : ""}`, preview: r.output.slice(-2500) });
      const tail = ok ? "" : "\n" + r.output.slice(-Math.min(2400, Math.floor(this.settings.maxResultChars / 2)));
      return { ok, line: `Auto-verification (Forge ran it for you): \`${command}\` → ${ok ? "no new failures" : `new failures: ${introduced.join(", ") || "exit " + r.exitCode}`} · ${r.summary}${note}${tail}` };
    } catch (error) {
      if (this.signal.aborted) throw error;
      this.emit({ type: "tool.end", id, ok: false, ms: Date.now() - t0, summary: `skipped: ${(error as Error).message.slice(0, 120)}` });
      return undefined;
    }
  }
}

function firstLine(text: string) { return text.split("\n", 1)[0].slice(0, 160); }
function bound(text: string, max: number) { return text.length > max ? text.slice(0, max - 60) + "\n[result truncated to the configured limit]" : text; }
