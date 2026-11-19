import type { RepoMapIndex } from "../repoMap";
import type { Workspace } from "./workspace";

/**
 * Automatic context assembly.
 *
 * Before the first model call Forge builds a *context pack*: a ranked, budgeted selection
 * of the files and symbols most likely to matter for the request, each with a stated
 * reason. The pack replaces the many search/read round-trips that dominate token use on
 * small free-tier models. The agent can still search and read anything else.
 *
 * Ranking signals (all deterministic, no model calls):
 *  1. IDF-weighted term matches in file contents, boosted on definition lines.
 *  2. Path matches (e.g. `cli` in `src/flask/cli.py`).
 *  3. RepoMap symbol search and static graph neighbours (callers, tests) of the top symbols.
 *  4. Module affinity: tests and docs named after the top implementation file.
 *  5. Explicit @file / @symbol mentions, which are always included first.
 */
export type Role = "implementation" | "test" | "docs" | "config";

export interface PackExcerpt { start: number; end: number; label: string; text: string }
export interface PackFile { path: string; role: Role; score: number; reasons: string[]; outline: string; excerpts: PackExcerpt[]; tokens: number }
export interface GraphNode { name: string; kind?: string; file: string; line: number }
/** The RepoMap neighbourhood of the most relevant symbol (static analysis, verified against source lines). */
export interface GraphInfo { focus: GraphNode; related: GraphNode[]; callers: GraphNode[]; callees: GraphNode[]; tests: string[]; /** Callers are kept only when the call-site line names the symbol. */ verifiedEdges: number; droppedEdges: number }
export interface ContextPack { terms: string[]; files: PackFile[]; tokens: number; budget: number; omitted: { path: string; score: number }[]; graph: boolean; graphInfo?: GraphInfo; ms: number }
export interface Mentions { files: string[]; symbols: { name: string; path: string; line: number }[] }

export const estimateTokens = (text: string) => Math.ceil(text.length / 3.6);

const STOP = new Set(("a an the and or but if then else for to of in on at by with from into onto as is are was were be been being it its this that these those " +
  "must should could would will shall can may might do does did done have has had not no yes so such than too very also just only " +
  "add adds added new make makes made use uses using used any all each every other another some more most same own about above below " +
  "when where which who whom whose what why how there here their them they you your we our us i me my he she his her " +
  "value values well like via per both either neither within without while until across along alongside covered documented").split(/\s+/));

/** Identifier-aware term extraction: keeps snake/camel identifiers and their parts. */
export function extractTerms(request: string): string[] {
  const out = new Set<string>();
  for (const raw of request.match(/[A-Za-z_][A-Za-z0-9_.-]*/g) ?? []) {
    const word = raw.replace(/[.-]+$/, "");
    const lower = word.toLowerCase();
    if (lower.length >= 3 && !STOP.has(lower)) out.add(lower.replace(/s$/, "").length >= 3 && !/ss$/.test(lower) ? lower.replace(/s$/, "") : lower);
    for (const part of word.split(/[_.-]|(?<=[a-z])(?=[A-Z])/)) {
      const p = part.toLowerCase();
      if (p.length >= 3 && !STOP.has(p)) out.add(p);
    }
  }
  return [...out].slice(0, 24);
}

/** Words that say which kinds of files to include rather than what to search for. */
const INTENT_WORDS = new Set(["test", "tests", "tested", "testing", "doc", "docs", "documentation", "documented", "document", "readme", "spec", "specs", "unit"]);
export function roleIntent(request: string): Set<Role> {
  const roles = new Set<Role>();
  if (/\b(test|tests|tested|testing|spec|coverage|covered)\b/i.test(request)) roles.add("test");
  if (/\b(doc|docs|document|documented|documentation|readme)\b/i.test(request)) roles.add("docs");
  return roles;
}

export function roleOf(file: string): Role {
  if (/(^|\/)(tests?|specs?|__tests__)\/|(^|\/)test_[^/]+$|_test\.\w+$|\.(test|spec)\.\w+$/i.test(file)) return "test";
  if (/^(docs?|documentation)\/|\.(rst|md|markdown|adoc)$/i.test(file) || /(^|\/)(README|CHANGES|CHANGELOG)/i.test(file)) return "docs";
  if (/\.(toml|cfg|ini|ya?ml|json|lock)$/i.test(file)) return "config";
  return "implementation";
}

const LIMITS: Record<Role, number> = { implementation: 3, test: 2, docs: 2, config: 1 };
const SHARE: Record<Role, number> = { implementation: 0.55, test: 0.25, docs: 0.15, config: 0.05 };
const DEF_LINE = /^\s*(?:@|(?:async\s+)?def |class |(?:export\s+)?(?:async\s+)?function |(?:export\s+)?(?:const|let|interface|type|enum)\s|func |fn |pub fn )|^\s*[=\-~^]{3,}\s*$/;

interface Candidate { path: string; role: Role; score: number; reasons: string[]; hits: { line: number; weight: number; terms: string[] }[]; /** Graph, definition, naming or mention evidence (not just shared words). */ structural?: boolean }

export async function assembleContext(ws: Workspace, request: string, opts: {
  budget: number; mentions?: Mentions; repomap?: RepoMapIndex; signal?: AbortSignal;
}): Promise<ContextPack> {
  const t0 = Date.now();
  const wantRoles = roleIntent(request);
  const terms = extractTerms(request).filter(t => !INTENT_WORDS.has(t));
  const identifiers = (request.match(/\b[A-Za-z_][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g) ?? []).map(x => x.toLowerCase());
  const candidates = new Map<string, Candidate>();
  const get = (file: string) => {
    let c = candidates.get(file);
    if (!c) { c = { path: file, role: roleOf(file), score: 0, reasons: [], hits: [] }; candidates.set(file, c); }
    return c;
  };

  // 1-2. Lexical evidence: BM25 over lines (length-normalised), plus filename matches.
  const docFreq = new Map<string, number>();
  const perFile = new Map<string, { lines: string[]; found: Map<string, number[]> }>();
  let totalLines = 0;
  for (const file of ws.files) {
    opts.signal?.throwIfAborted();
    const lines = ws.tryLines(file);
    if (!lines) continue;
    totalLines += lines.length;
    const stem = file.toLowerCase();
    const found = new Map<string, number[]>();
    for (const term of terms) {
      const at: number[] = [];
      for (let i = 0; i < lines.length && at.length < 300; i++) if (lines[i].toLowerCase().includes(term)) at.push(i + 1);
      if (at.length || stem.includes(term)) found.set(term, at);
    }
    if (found.size) { perFile.set(file, { lines, found }); for (const t of found.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1); }
  }
  const total = Math.max(1, ws.files.length), avgLen = Math.max(1, totalLines / total);
  const idf = (t: string) => Math.max(0.05, Math.log((total - (docFreq.get(t) ?? 0) + 0.5) / ((docFreq.get(t) ?? 0) + 0.5) + 1));
  const K1 = 1.2, B = 0.75;
  for (const [file, { lines, found }] of perFile) {
    const c = get(file);
    const name = file.toLowerCase().split("/").pop()!.replace(/\.\w+$/, "");
    const pathTerms: string[] = [], contentTerms: string[] = [];
    const byLine = new Map<number, { weight: number; terms: string[] }>();
    for (const [term, at] of found) {
      const w = idf(term);
      if (name.includes(term) && term.length >= 3) { c.score += 1.5 * w; pathTerms.push(term); }
      if (!at.length) continue;
      contentTerms.push(term);
      const tf = at.length;
      c.score += w * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * lines.length / avgLen));
      for (const line of at) {
        const slot = byLine.get(line) ?? { weight: 0, terms: [] };
        slot.weight += w * (DEF_LINE.test(lines[line - 1]) ? 2.5 : 1); slot.terms.push(term); byLine.set(line, slot);
      }
    }
    // A file that *defines* an identifier named in the request is the strongest signal.
    for (const ident of identifiers) {
      const def = (() => { try { return ws.outline(file).find(sym => sym.name.toLowerCase() === ident); } catch { return undefined; } })();
      if (def) { c.score += 25; c.structural = true; c.reasons.unshift(`defines ${def.name}`); byLine.set(def.line, { weight: 1000, terms: [ident] }); }
    }
    // Lines where several query terms co-occur are strong evidence (e.g. a registration site).
    let proximity = 0;
    for (const v of byLine.values()) if (v.terms.length >= 2) proximity += v.weight * 0.15;
    c.score += Math.min(proximity, c.score);
    if (/(^|\/)(CHANGES|CHANGELOG|HISTORY|NEWS)[^/]*$/i.test(file)) c.score *= 0.3;
    if (wantRoles.size && !wantRoles.has(c.role) && c.role !== "implementation") c.score *= 0.6;
    c.hits = [...byLine].map(([line, v]) => ({ line, ...v })).sort((a, b) => b.weight - a.weight).slice(0, 12);
    if (pathTerms.length) c.reasons.push(`filename matches ${pathTerms.join(", ")}`);
    if (contentTerms.length) c.reasons.push(`mentions ${contentTerms.sort((a, b) => idf(b) - idf(a)).slice(0, 5).join(", ")}`);
  }

  // 3. RepoMap symbol search and graph neighbours.
  let graph = false;
  let graphInfo: GraphInfo | undefined;
  if (opts.repomap) {
    try {
      const found = await opts.repomap.find(request.slice(0, 300), opts.signal);
      graph = true;
      for (const [rank, hit] of found.hits.slice(0, 5).entries()) {
        const c = get(hit.file);
        c.score += 6 / (rank + 1);
        c.reasons.push(`RepoMap symbol ${hit.name} (rank ${rank + 1})`);
        c.hits.unshift({ line: hit.line, weight: 100 - rank, terms: [hit.name] });
      }
      // Focus the graph on the RepoMap hit inside the best lexical implementation file, so both signals agree.
      const lexicalBest = [...candidates.values()].filter(c => c.role === "implementation").sort((a, b) => b.score - a.score)[0]?.path;
      const top = found.hits.find((h: any) => h.file === lexicalBest) ?? found.hits[0];
      if (top) {
        const ctx = await opts.repomap.context(top.id, opts.signal);
        // Keep only edges whose call-site line really names the symbol ("verified at call site").
        const verified = ctx.callers.filter((r: any) => r.referenceMatch === "name present in source");
        for (const rel of verified.slice(0, 3)) {
          const c = get(rel.siteFile);
          c.score += 2;
          c.reasons.push(`calls ${top.name} (static graph)`);
          c.structural = true;
          if (rel.at) c.hits.push({ line: rel.at, weight: 20, terms: [top.name] });
        }
        for (const test of ctx.tests.slice(0, 3)) { const c = get(test); c.score += 3; c.structural = true; c.reasons.push(`RepoMap test for ${top.name}`); }
        get(top.file).structural = true;
        const node = (x: any, file?: string, line?: number): GraphNode => ({ name: x.name, kind: x.kind, file: file ?? x.file, line: line ?? x.line });
        graphInfo = {
          focus: node(top),
          related: found.hits.filter((h: any) => h !== top).slice(0, 4).map((h: any) => node(h)),
          callers: verified.slice(0, 4).map((r: any) => node(r.symbol, r.siteFile, r.at ?? r.symbol.line)),
          callees: ctx.callees.slice(0, 4).map((r: any) => node(r.symbol)),
          tests: ctx.tests.slice(0, 4),
          verifiedEdges: verified.length, droppedEdges: ctx.callers.length - verified.length,
        };
      }
    } catch { /* RepoMap is optional; lexical ranking still works. */ }
  }

  // 4. Module affinity between the best implementation file and tests/docs.
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
  const topImpl = ranked.find(c => c.role === "implementation");
  if (topImpl) {
    const stem = topImpl.path.split("/").pop()!.replace(/\.\w+$/, "").toLowerCase();
    for (const c of ranked) {
      if (c.role === "implementation" || stem.length < 3) continue;
      const name = c.path.split("/").pop()!.toLowerCase();
      if (name.includes(stem)) { c.score *= 1.8; c.structural = true; c.reasons.push(`named after ${topImpl.path}`); }
    }
  }

  // 5. Explicit mentions always win.
  const mentioned = new Set<string>();
  for (const file of opts.mentions?.files ?? []) if (ws.has(file)) { const c = get(file); c.score += 1000; c.structural = true; c.reasons.unshift("mentioned with @file"); mentioned.add(file); }
  for (const s of opts.mentions?.symbols ?? []) if (ws.has(s.path)) {
    const c = get(s.path); c.score += 1000; c.reasons.unshift(`mentioned @symbol ${s.name}`); c.hits.unshift({ line: s.line, weight: 1e6, terms: [s.name] }); mentioned.add(s.path);
  }

  // Selection: the best file of each wanted role first, then the strongest remaining ones.
  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);
  const tight = opts.budget < 4000;
  const maxFiles = tight ? 3 : 5;
  const roles: Role[] = ["implementation", ...(["test", "docs"] as Role[]).filter(r => wantRoles.has(r))];
  const selected: Candidate[] = sorted.filter(c => mentioned.has(c.path));
  for (const role of roles) { const best = sorted.find(c => c.role === role && !selected.includes(c)); if (best && best.score > 1.5) selected.push(best); }
  // Beyond the best file per role, a file must earn its place structurally (graph neighbour,
  // defines a named identifier, named after the module, or mentioned), not by shared words alone.
  for (const c of sorted) {
    if (selected.length >= maxFiles + mentioned.size) break;
    const best = sorted.find(x => x.role === c.role)?.score ?? 0;
    const sameRole = selected.filter(x => x.role === c.role).length;
    if (!selected.includes(c) && c.structural && sameRole < LIMITS[c.role] && c.score >= best * 0.3) selected.push(c);
  }
  // Exact symbol ranges from RepoMap's AST index for the chosen files (patterns remain the fallback).
  if (opts.repomap) {
    await Promise.all(selected.map(async c => {
      try { if (!ws.hasParsedOutline(c.path)) ws.setParsedOutline(c.path, await opts.repomap!.members(c.path, opts.signal)); } catch { /* keep the pattern outline */ }
    }));
  }
  const files: PackFile[] = [];
  let used = 0;
  for (const c of selected.sort((a, b) => b.score - a.score)) {
    const share = mentioned.has(c.path) ? 0.5 : SHARE[c.role];
    const fileBudget = Math.min(opts.budget - used, Math.max(400, Math.floor(opts.budget * share / Math.max(1, selected.filter(s => s.role === c.role).length) * 1.4)));
    if (fileBudget < 150) continue;
    const pf = buildFile(ws, c, fileBudget, tight ? 12 : 30, terms, idf);
    if (!pf) continue;
    files.push(pf);
    used += pf.tokens;
    if (used >= opts.budget) break;
  }
  const chosen = new Set(files.map(f => f.path));
  return {
    terms, files, tokens: used, budget: opts.budget, graph, graphInfo, ms: Date.now() - t0,
    omitted: sorted.filter(c => !chosen.has(c.path)).slice(0, 8).map(c => ({ path: c.path, score: round(c.score) })),
  };
}

function buildFile(ws: Workspace, c: Candidate, budget: number, outlineLimit: number, terms: string[], idf: (t: string) => number): PackFile | undefined {
  const lines = ws.tryLines(c.path);
  if (!lines) return;
  // Outline: prefer top-level symbols and those nearest to the evidence, in file order.
  const hitLines = c.hits.map(h => h.line);
  const near = (line: number) => Math.min(...hitLines.map(h => Math.abs(h - line)), 1e9);
  const outlineSymbols = ws.outline(c.path).filter(s => s.depth <= 4)
    .map(s => ({ s, rank: (s.depth === 0 ? 0 : 50) + near(s.line) / 10 }))
    .sort((a, b) => a.rank - b.rank).slice(0, outlineLimit).map(x => x.s).sort((a, b) => a.line - b.line);
  const outline = outlineSymbols.map(s => `L${s.line}-${s.end} ${s.text}`).join("\n");
  let tokens = estimateTokens(outline) + 30;
  const excerpts: PackExcerpt[] = [];
  const covered: [number, number][] = [];
  const overlaps = (a: number, b: number) => covered.some(([x, y]) => a <= y && b >= x);
  const add = (start: number, end: number, label: string) => {
    if (overlaps(start, end)) return false;
    const text = lines.slice(start - 1, end).join("\n");
    const cost = estimateTokens(text) + 12;
    if (tokens + cost > budget) return false;
    excerpts.push({ start, end, label, text }); covered.push([start, end]); tokens += cost;
    return true;
  };
  // Score whole symbols (functions, classes, doc sections) by query-term density so the pack
  // shows analogous code ("how the existing ones are written, registered, tested, documented").
  const symbols = ws.outline(c.path).filter(sym => sym.end - sym.line <= 120);
  const pinned = new Set(c.hits.filter(h => h.weight >= 1000).map(h => h.line));
  const scored = symbols.map(sym => {
    const body = lines.slice(sym.line - 1, sym.end).join("\n").toLowerCase();
    const name = sym.name.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const n = body.split(t).length - 1;
      if (n) score += idf(t) * Math.min(3, n) + (name.includes(t) ? 6 * idf(t) : 0);
    }
    if ([...pinned].some(line => line >= sym.line && line <= sym.end)) score += 1000;
    return { sym, score: score / Math.sqrt(1 + (sym.end - sym.line) / 80) };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  for (const { sym } of scored) {
    // Skip a container when a better-scoring child is already shown.
    if (excerpts.length >= 4) break;
    add(sym.line, sym.end, sym.name);
  }
  // Fall back to short windows around the strongest line hits.
  for (const hit of c.hits) {
    if (excerpts.length >= 4) break;
    const sym = ws.enclosing(c.path, hit.line);
    add(Math.max(1, hit.line - 6), Math.min(lines.length, hit.line + 10), sym ? `${sym.name} (part)` : `around line ${hit.line}`);
  }
  if (!excerpts.length && !outline) return;
  return { path: c.path, role: c.role, score: round(c.score), reasons: [...new Set(c.reasons)].slice(0, 4), outline, excerpts: excerpts.sort((a, b) => a.start - b.start), tokens };
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Render the pack as the first-message context. Code is unnumbered so it can be copied as edit anchors. */
export function renderPack(pack: ContextPack): string {
  const out: string[] = [
    `## Context assembled automatically by Forge (~${pack.tokens} of ${pack.budget} tokens)`,
    "Selected files and why:",
    ...pack.files.map((f, i) => `${i + 1}. ${f.path} [${f.role}] — ${f.reasons.join("; ")}`),
  ];
  if (pack.omitted.length) out.push(`Other candidates not included: ${pack.omitted.slice(0, 5).map(o => o.path).join(", ")}`);
  const g = pack.graphInfo;
  if (g) {
    const at = (n: GraphNode) => `${n.name} (${n.file}:${n.line})`;
    out.push("", "Code graph (RepoMap static analysis; edges are inferred, verify in source):",
      `- focus: ${at(g.focus)}${g.focus.kind ? ` [${g.focus.kind}]` : ""}`,
      g.callers.length ? `- called from (each verified at its call-site line): ${g.callers.map(at).join(", ")}` : "",
      g.callees.length ? `- calls: ${g.callees.map(at).join(", ")}` : "",
      g.tests.length ? `- tests: ${g.tests.join(", ")}` : "",
      g.related.length ? `- related symbols: ${g.related.map(at).join(", ")}` : "");
    while (out.at(-1) === "") out.pop();
    for (let i = out.length - 1; i >= 0; i--) if (out[i] === "" && out[i - 1]?.startsWith("- ")) out.splice(i, 1);
  }
  for (const f of pack.files) {
    out.push("", `### ${f.path}`);
    if (f.outline) out.push("Outline (line ranges):", f.outline);
    for (const e of f.excerpts) out.push(`\n${f.path} lines ${e.start}-${e.end} (${e.label}):`, "```", e.text, "```");
  }
  return out.join("\n");
}
