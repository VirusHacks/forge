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
  /** Settle the pending review from the editor (same effect as the sidebar's buttons). */
  decide(reviewId: string, indices: number[] | undefined): void;
  /** Keep the sidebar's checkboxes in sync with decisions made in the diff editor. */
  hunkStates(reviewId: string, accepted: number[], decided: number[]): void;
}

interface FileHunk extends LineHunk { index: number; path: string; local: number; /** 0-based first line in the proposed document. */ nextLine: number }
interface HunkState { accepted: boolean; decided: boolean }
const SCHEME = "forge-review";

export class ReviewController implements vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly provider: vscode.Disposable;
  private readonly active = new Map<string, { root: string; files: ProposalFile[]; hunks: FileHunk[]; states: HunkState[] }>();
  private readonly lensChanged = new vscode.EventEmitter<void>();
  private readonly lenses: vscode.Disposable;
  private lastApplied?: { root: string; files: { path: string; before: string | null; after: string }[] };

  constructor(private readonly surface: ReviewSurface) {
    this.provider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: uri => this.contents.get(uri.toString()) ?? "" });
    // Accept / Reject buttons on every hunk, inside the diff editor itself.
    this.lenses = vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, { onDidChangeCodeLenses: this.lensChanged.event, provideCodeLenses: doc => this.codeLenses(doc) });
  }

  private codeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const [reviewId, side] = doc.uri.query.split(":");
    const review = this.active.get(reviewId);
    if (!review || side !== "next") return [];
    const file = doc.uri.path.slice(1);
    const mine = review.hunks.filter(h => h.path === file);
    return mine.flatMap(h => {
      const st = review.states[h.index], line = Math.min(h.nextLine, Math.max(0, doc.lineCount - 1)), at = new vscode.Range(line, 0, line, 0);
      const label = `Hunk ${h.index + 1}/${review.hunks.length}`;
      if (!st.decided) return [
        new vscode.CodeLens(at, { title: `✓ Accept ${label}`, command: "forge.hunkAccept", arguments: [reviewId, h.index] }),
        new vscode.CodeLens(at, { title: "✕ Reject", command: "forge.hunkReject", arguments: [reviewId, h.index] }),
      ];
      return [new vscode.CodeLens(at, st.accepted
        ? { title: `✓ ${label} accepted — click to reject`, command: "forge.hunkReject", arguments: [reviewId, h.index] }
        : { title: `✕ ${label} rejected — click to accept`, command: "forge.hunkAccept", arguments: [reviewId, h.index] })];
    });
  }

  /** The review shown in the active editor, if any. */
  private activeReviewId(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === SCHEME ? uri.query.split(":")[0] : [...this.active.keys()].at(-1);
  }

  /**
   * Record a decision for one hunk (from the editor or the sidebar). When every hunk has been
   * decided in the editor, the accepted ones are applied automatically.
   */
  decideHunk(reviewId: string | undefined, index: number | undefined, accepted: boolean, source: "editor" | "sidebar" = "editor") {
    reviewId ??= this.activeReviewId();
    const review = reviewId ? this.active.get(reviewId) : undefined;
    if (!review) return;
    if (index === undefined) {
      const editor = vscode.window.activeTextEditor, file = editor?.document.uri.path.slice(1), line = editor?.selection.active.line ?? 0;
      index = review.hunks.find(h => h.path === file && line >= h.nextLine && line < h.nextLine + Math.max(1, h.added.length))?.index
        ?? review.hunks.find(h => h.path === file && !review.states[h.index].decided)?.index;
    }
    if (index === undefined || !review.states[index]) return;
    review.states[index] = { accepted, decided: source === "editor" ? true : review.states[index].decided };
    this.lensChanged.fire();
    this.surface.hunkStates(reviewId!, review.states.flatMap((s, i) => (s.accepted ? [i] : [])), review.states.flatMap((s, i) => (s.decided ? [i] : [])));
    if (source === "editor" && review.states.every(s => s.decided)) this.applyDecisions(reviewId);
  }

  /** Apply whatever is currently accepted (editor title button, keybinding or last decision). */
  applyDecisions(reviewId?: string) {
    reviewId ??= this.activeReviewId();
    const review = reviewId ? this.active.get(reviewId) : undefined;
    if (!review) return;
    const accepted = review.states.flatMap((s, i) => (s.accepted ? [i] : []));
    this.surface.decide(reviewId!, accepted.length ? accepted : undefined);
  }

  rejectAll(reviewId?: string) {
    reviewId ??= this.activeReviewId();
    if (reviewId && this.active.has(reviewId)) this.surface.decide(reviewId, undefined);
  }

  get canUndo() { return Boolean(this.lastApplied); }

  async review(runId: string, root: string, proposal: Proposal, signal: AbortSignal): Promise<ReviewOutcome> {
    const declined: ReviewOutcome = { applied: false, selected: [], files: [] };
    const reviewId = randomUUID();
    const hunks: FileHunk[] = [];
    for (const file of proposal.files) {
      let shift = 0;
      diffLines(file.base ?? "", file.next).forEach((h, local) => {
        hunks.push({ ...h, index: hunks.length, path: file.path, local, nextLine: h.startLine + shift });
        shift += h.added.length - h.removed.length;
      });
    }
    if (!hunks.length) return declined;
    this.active.set(reviewId, { root, files: proposal.files, hunks, states: hunks.map(() => ({ accepted: true, decided: false })) });
    const tabs: vscode.Uri[] = [];
    try {
      for (const file of proposal.files) {
        const base = vscode.Uri.from({ scheme: SCHEME, path: `/${file.path}`, query: `${reviewId}:base` });
        const next = vscode.Uri.from({ scheme: SCHEME, path: `/${file.path}`, query: `${reviewId}:next` });
        this.contents.set(base.toString(), file.base ?? "");
        this.contents.set(next.toString(), file.next);
        tabs.push(next);
      }
      // Open every proposed file as a diff. Decisions can be made per hunk in the diff (CodeLens) or in the sidebar.
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
      this.lensChanged.fire();
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

  dispose() { this.provider.dispose(); this.lenses.dispose(); this.lensChanged.dispose(); this.contents.clear(); }
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
