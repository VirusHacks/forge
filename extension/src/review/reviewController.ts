import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyHunks, diffLines, hunkPreview, splitLines, type LineHunk } from "../core/diff";
import type { ReviewHunkSummary, VerificationSummary } from "../core/events";

/**
 * Per-hunk review of a proposal, shared by inline edits and agent mode.
 *
 * Nothing touches the workspace until the user accepts hunks. At apply time each target is
 * re-opened and compared with the exact base the proposal was computed from, so a file
 * edited during review is never overwritten. Accepted hunks are applied in one
 * WorkspaceEdit (one editor undo step) and saved; `undoLast` restores the previous text.
 */
export interface ProposalFile { path: string; base: string | null; next: string }
export interface Proposal { files: ProposalFile[]; summary?: string; verification?: VerificationSummary; note?: string; title: string }
export interface ReviewOutcome { applied: boolean; selected: number[]; files: string[] }

export interface ReviewSurface {
  /** Show hunks for selection; resolves with accepted indices, or undefined when rejected/cancelled. */
  requestReview(runId: string, request: { reviewId: string; hunks: ReviewHunkSummary[]; summary?: string; verification?: VerificationSummary; note?: string }, signal: AbortSignal): Promise<number[] | undefined>;
  reviewApplied(runId: string, outcome: { applied: boolean; files: string[]; hunks: number }): void;
  reveal(): void;
}

interface FileHunk extends LineHunk { index: number; path: string; local: number }
const SCHEME = "forge-review";

export class ReviewController implements vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly provider: vscode.Disposable;
  private readonly active = new Map<string, { root: string; files: ProposalFile[]; hunks: FileHunk[] }>();
  private lastApplied?: { root: string; files: { path: string; before: string | null; after: string }[] };

  constructor(private readonly surface: ReviewSurface) {
    this.provider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: uri => this.contents.get(uri.toString()) ?? "" });
  }

  get canUndo() { return Boolean(this.lastApplied); }

  async review(runId: string, root: string, proposal: Proposal, signal: AbortSignal): Promise<ReviewOutcome> {
    const declined: ReviewOutcome = { applied: false, selected: [], files: [] };
    const reviewId = randomUUID();
    const hunks: FileHunk[] = [];
    for (const file of proposal.files) {
      diffLines(file.base ?? "", file.next).forEach((h, local) => hunks.push({ ...h, index: hunks.length, path: file.path, local }));
    }
    if (!hunks.length) return declined;
    this.active.set(reviewId, { root, files: proposal.files, hunks });
    const tabs: vscode.Uri[] = [];
    try {
      for (const file of proposal.files) {
        const base = vscode.Uri.from({ scheme: SCHEME, path: `/${file.path}`, query: `${reviewId}:base` });
        const next = vscode.Uri.from({ scheme: SCHEME, path: `/${file.path}`, query: `${reviewId}:next` });
        this.contents.set(base.toString(), file.base ?? "");
        this.contents.set(next.toString(), file.next);
        tabs.push(next);
      }
      // Open every proposed file as a diff. The sidebar holds the per-hunk decisions.
      for (const [i, file] of proposal.files.entries()) await this.openDiff(reviewId, file.path, i === 0);
      this.surface.reveal();
      const summaries: ReviewHunkSummary[] = hunks.map(h => ({
        index: h.index, path: h.path, line: h.startLine + 1, added: h.added.length, removed: h.removed.length,
        preview: hunkPreview(h, 18), newFile: proposal.files.find(f => f.path === h.path)?.base === null,
      }));
      const picked = await this.surface.requestReview(runId, { reviewId, hunks: summaries, summary: proposal.summary, verification: proposal.verification, note: proposal.note }, signal);
      if (!picked?.length || signal.aborted) { this.surface.reviewApplied(runId, { applied: false, files: [], hunks: 0 }); return declined; }
      const selected = [...new Set(picked)].filter(i => Number.isInteger(i) && i >= 0 && i < hunks.length);
      const files = await this.apply(root, proposal.files, hunks, new Set(selected));
      this.surface.reviewApplied(runId, { applied: true, files, hunks: selected.length });
      return { applied: true, selected, files };
    } finally {
      this.active.delete(reviewId);
      await closeTabs(tabs);
      for (const uri of tabs) { this.contents.delete(uri.toString()); this.contents.delete(uri.with({ query: uri.query.replace(/:next$/, ":base") }).toString()); }
    }
  }

  /** Open (or focus) the diff for one file of an active review. */
  async openDiff(reviewId: string, file: string, focus = true) {
    const base = vscode.Uri.from({ scheme: SCHEME, path: `/${file}`, query: `${reviewId}:base` });
    const next = vscode.Uri.from({ scheme: SCHEME, path: `/${file}`, query: `${reviewId}:next` });
    if (!this.contents.has(next.toString())) return;
    await vscode.commands.executeCommand("vscode.diff", base, next, `${file} ↔ Forge proposal`, { preview: false, preserveFocus: !focus });
  }

  /** Focus the diff and the hunk's line. */
  async revealHunk(reviewId: string, index: number) {
    const review = this.active.get(reviewId);
    const hunk = review?.hunks[index];
    if (!hunk) return;
    await this.openDiff(reviewId, hunk.path, true);
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const line = Math.max(0, hunk.startLine + (hunk.added.length ? 0 : -1));
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(line, 0, line, 0);
    }
  }

  private async apply(root: string, files: ProposalFile[], hunks: FileHunk[], selected: Set<number>): Promise<string[]> {
    const edit = new vscode.WorkspaceEdit();
    const plan: { path: string; uri: vscode.Uri; before: string | null; after: string }[] = [];
    for (const file of files) {
      const mine = hunks.filter(h => h.path === file.path);
      const chosen = mine.filter(h => selected.has(h.index));
      if (!chosen.length) continue;
      const uri = vscode.Uri.file(path.join(root, file.path));
      const after = applyHunks(file.base ?? "", mine, chosen.map(h => h.local));
      if (file.base === null) {
        if (await exists(uri)) throw new Error(`${file.path} was created by someone else during review.`);
        edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
        edit.insert(uri, new vscode.Position(0, 0), after);
      } else {
        // Re-acquire the document now; never trust a handle held across a long review.
        const doc = await vscode.workspace.openTextDocument(uri);
        if (doc.isDirty) throw new Error(`${file.path} has unsaved changes. Save or revert it, then review again.`);
        if (doc.getText() !== file.base) throw new Error(`${file.path} changed after the proposal was made. Nothing was written.`);
        const offsets = lineOffsets(file.base);
        for (const h of chosen) {
          edit.replace(uri, new vscode.Range(doc.positionAt(offsets[h.startLine]), doc.positionAt(offsets[h.endLine])), h.added.join(""));
        }
      }
      plan.push({ path: file.path, uri, before: file.base, after });
    }
    if (!plan.length) return [];
    if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code declined the edit. Nothing was written.");
    for (const item of plan) {
      const doc = await vscode.workspace.openTextDocument(item.uri);
      if (doc.getText() !== item.after) throw new Error(`${item.path}: the applied text differs from the approved hunks. Use Undo (Cmd/Ctrl+Z) to revert.`);
      if (!await doc.save()) throw new Error(`${item.path} could not be saved; the change is in the editor buffer.`);
    }
    this.lastApplied = { root, files: plan.map(p => ({ path: p.path, before: p.before, after: p.after })) };
    return plan.map(p => p.path);
  }

  /** Revert the most recent applied review, if the files still contain exactly what was applied. */
  async undoLast(): Promise<string> {
    const last = this.lastApplied;
    if (!last) return "Nothing to undo.";
    const edit = new vscode.WorkspaceEdit();
    const restored: string[] = [], skipped: string[] = [];
    for (const file of last.files) {
      const uri = vscode.Uri.file(path.join(last.root, file.path));
      const doc = await vscode.workspace.openTextDocument(uri).then(d => d, () => undefined);
      if (!doc || doc.getText() !== file.after) { skipped.push(file.path); continue; }
      if (file.before === null) edit.deleteFile(uri, { ignoreIfNotExists: true });
      else edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), file.before);
      restored.push(file.path);
    }
    if (restored.length && !await vscode.workspace.applyEdit(edit)) return "VS Code declined the undo.";
    for (const file of last.files) {
      if (!restored.includes(file.path) || file.before === null) continue;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(last.root, file.path)));
      await doc.save();
    }
    this.lastApplied = undefined;
    return skipped.length ? `Restored ${restored.length} file(s). Skipped ${skipped.join(", ")} because it changed after the edit.` : `Restored ${restored.length} file(s) to their previous content.`;
  }

  dispose() { this.provider.dispose(); this.contents.clear(); }
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (const line of splitLines(text)) offsets.push(offsets.at(-1)! + line.length);
  return offsets;
}

async function exists(uri: vscode.Uri) { try { await readFile(uri.fsPath); return true; } catch { return false; } }

async function closeTabs(proposed: vscode.Uri[]) {
  const keys = new Set(proposed.map(u => u.toString()));
  const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputTextDiff && keys.has(t.input.modified.toString()));
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true).then(undefined, () => undefined);
}
