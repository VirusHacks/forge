/**
 * Line diff used to split a proposal into independently reviewable hunks.
 * A hunk replaces base lines [startLine, endLine) with `lines`. Offsets refer to the base text.
 */
export interface LineHunk {
  startLine: number;      // 0-based, inclusive, in base
  endLine: number;        // 0-based, exclusive, in base
  removed: string[];
  added: string[];
}

export function splitLines(text: string): string[] {
  // Keep line terminators so applying hunks is byte-exact.
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Common prefix/suffix trimming plus LCS on the changed middle. */
export function diffLines(base: string, next: string): LineHunk[] {
  const a = splitLines(base), b = splitLines(next);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  if (!midA.length && !midB.length) return [];
  if (midA.length * midB.length > 4_000_000) return [{ startLine: start, endLine: endA, removed: midA, added: midB }];

  const n = midA.length, m = midB.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const hunks: LineHunk[] = [];
  let i = 0, j = 0, current: LineHunk | undefined;
  const flush = () => { if (current) { hunks.push(current); current = undefined; } };
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) { flush(); i++; j++; continue; }
    current ??= { startLine: start + i, endLine: start + i, removed: [], added: [] };
    if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { current.added.push(midB[j]); j++; }
    else { current.removed.push(midA[i]); current.endLine++; i++; }
  }
  flush();
  return mergeClose(hunks, a);
}

/** Merge hunks separated by at most one unchanged line so reviews are not fragmented. */
function mergeClose(hunks: LineHunk[], base: string[]): LineHunk[] {
  const out: LineHunk[] = [];
  for (const h of hunks) {
    const prev = out.at(-1);
    if (prev && h.startLine - prev.endLine <= 1) {
      const gap = base.slice(prev.endLine, h.startLine);
      prev.removed.push(...gap, ...h.removed);
      prev.added.push(...gap, ...h.added);
      prev.endLine = h.endLine;
    } else out.push({ ...h, removed: [...h.removed], added: [...h.added] });
  }
  return out;
}

/** Apply a subset of hunks (by index) to the base text. */
export function applyHunks(base: string, hunks: LineHunk[], selected: Iterable<number>): string {
  const keep = new Set(selected);
  const lines = splitLines(base);
  const ordered = hunks.map((h, i) => ({ h, i })).filter(x => keep.has(x.i)).sort((x, y) => y.h.startLine - x.h.startLine);
  for (const { h } of ordered) lines.splice(h.startLine, h.endLine - h.startLine, ...h.added);
  return lines.join("");
}

/** Compact unified-style preview for UI cards and tool responses. */
export function hunkPreview(h: LineHunk, maxLines = 14): string {
  const rows = [...h.removed.map(l => "-" + l.replace(/\n$/, "")), ...h.added.map(l => "+" + l.replace(/\n$/, ""))];
  return rows.length > maxLines ? [...rows.slice(0, maxLines), `… ${rows.length - maxLines} more lines`].join("\n") : rows.join("\n");
}
