import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ReviewHunkSummary, RunStatus, UiEvent, VerificationSummary } from "../core/events";
import type { ReviewSurface } from "../review/reviewController";

/**
 * The Forge activity-bar view. The webview only renders; every message it sends is
 * validated here, and only the extension host talks to TrueForge.
 */
export type RunKind = "agent" | "inline";
export interface Run { id: string; kind: RunKind; title: string; model: string; status: "running" | RunStatus; startedAt: number; events: UiEvent[] }
export interface StartRequest { task: string; model: string; mentions: string[] }

type ClientMessage =
  | { type: "ready" } | { type: "start"; task: string; model: string; mentions: string[] } | { type: "stop"; runId: string }
  | { type: "decision"; reviewId: string; indices: number[] } | { type: "openHunk"; reviewId: string; index: number }
  | { type: "openFile"; path: string; line?: number } | { type: "openUrl"; url: string } | { type: "select"; runId: string }
  | { type: "models" } | { type: "model"; model: string } | { type: "clearHistory" } | { type: "attachFile" } | { type: "attachSymbol" } | { type: "undo" } | { type: "newChat" }
  | { type: "copy"; text: string } | { type: "toggleHunk"; reviewId: string; index: number; accepted: boolean };

const HISTORY_KEY = "forge.runHistory.v1";

interface PendingReview { runId: string; reviewId: string; count: number; resolve: (v: number[] | undefined) => void }

export class ForgeSidebar implements vscode.WebviewViewProvider, ReviewSurface, vscode.Disposable {
  private view?: vscode.WebviewView;
  private runs: Run[] = [];
  private current?: string;
  private models: string[] = [];
  private model = "";
  private modelError?: string;
  private pending?: PendingReview;
  private readonly flush = new Map<string, UiEvent[]>();
  private flushTimer?: NodeJS.Timeout;

  onStart?: (request: StartRequest, runId: string) => void;
  onStop?: (runId: string) => void;
  onOpenHunk?: (reviewId: string, index: number) => void;
  onUndo?: () => Promise<string>;
  onToggleHunk?: (reviewId: string, index: number, accepted: boolean) => void;
  onRefreshModels?: () => Promise<{ models: string[]; error?: string }>;
  onPickFile?: () => Promise<string | undefined>;
  onPickSymbol?: () => Promise<string | undefined>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.model = context.globalState.get<string>("forge.lastModel") ?? "";
    // Restore run history for this workspace; a run that was live when the window closed is marked as interrupted.
    const saved = context.workspaceState.get<Run[]>(HISTORY_KEY) ?? [];
    this.runs = saved.filter(r => r && typeof r.id === "string" && Array.isArray(r.events)).map(r => r.status === "running"
      ? { ...r, status: "cancelled" as const, events: [...r.events, { type: "run.end", status: "cancelled", message: "The window closed during this run; nothing was applied." } as UiEvent] }
      : r);
    this.current = this.runs.at(-1)?.id;
  }

  /** Persist a compact copy of the history (long previews trimmed, at most 25 runs). */
  private saveHistory() {
    const compact = this.runs.slice(-25).map(r => ({ ...r, events: r.events.slice(-400).map(e => {
      const c: Record<string, unknown> = { ...e };
      for (const k of ["preview", "text", "summary"]) if (typeof c[k] === "string" && (c[k] as string).length > 4000) c[k] = (c[k] as string).slice(0, 4000) + "…";
      return c as UiEvent;
    }) }));
    void this.context.workspaceState.update(HISTORY_KEY, compact).then(undefined, () => undefined);
  }

  get selectedModel() { return this.model; }
  get busy() { return this.runs.some(r => r.status === "running"); }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "forge.js"));
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "forge.css"));
    const nonce = randomUUID().replace(/-/g, "");
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data:; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body><main id="app" aria-live="polite"></main><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage(m => void this.receive(m), undefined, this.context.subscriptions);
    view.onDidDispose(() => { this.view = undefined; this.pending?.resolve(undefined); this.pending = undefined; }, undefined, this.context.subscriptions);
  }

  reveal() { void vscode.commands.executeCommand("forge.sidebar.focus").then(undefined, () => undefined); }

  // ---- run lifecycle -------------------------------------------------------
  startRun(kind: RunKind, title: string, model: string): string {
    const run: Run = { id: randomUUID(), kind, title, model, status: "running", startedAt: Date.now(), events: [] };
    this.runs = [...this.runs, run].slice(-25);
    this.current = run.id;
    this.postState();
    this.saveHistory();
    return run.id;
  }

  event(runId: string, event: UiEvent) {
    const run = this.runs.find(r => r.id === runId);
    if (!run) return;
    // Merge streaming deltas so history stays compact.
    const last = run.events.at(-1);
    if ((event.type === "assistant.delta" || event.type === "reasoning.delta") && last?.type === event.type) (last as { text: string }).text += event.text;
    else run.events.push({ ...event });
    if (run.events.length > 800) run.events.splice(0, run.events.length - 800);
    // Batch posts to the webview (~30 fps) so token streaming never floods it.
    const queue = this.flush.get(runId) ?? [];
    queue.push(event);
    this.flush.set(runId, queue);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      for (const [id, events] of this.flush) void this.view?.webview.postMessage({ type: "events", runId: id, events });
      this.flush.clear();
    }, 33);
  }

  finish(runId: string, status: RunStatus, message: string) {
    const run = this.runs.find(r => r.id === runId);
    if (!run) return;
    if (this.pending?.runId === runId) { this.pending.resolve(undefined); this.pending = undefined; }
    this.event(runId, { type: "run.end", status, message });
    run.status = status;
    this.saveHistory();
    setTimeout(() => this.postState(), 40);
  }

  // ---- ReviewSurface -------------------------------------------------------
  requestReview(runId: string, request: { reviewId: string; hunks: ReviewHunkSummary[]; summary?: string; verification?: VerificationSummary; note?: string }, signal: AbortSignal) {
    if (signal.aborted) return Promise.resolve(undefined);
    this.pending?.resolve(undefined);
    return new Promise<number[] | undefined>(resolve => {
      const done = (value: number[] | undefined) => { signal.removeEventListener("abort", abort); if (this.pending?.reviewId === request.reviewId) this.pending = undefined; resolve(value); };
      const abort = () => done(undefined);
      signal.addEventListener("abort", abort, { once: true });
      this.pending = { runId, reviewId: request.reviewId, count: request.hunks.length, resolve: done };
      this.event(runId, { type: "review.request", reviewId: request.reviewId, hunks: request.hunks, summary: request.summary, verification: request.verification });
      if (request.note) this.event(runId, { type: "notice", level: "info", message: request.note });
      this.postState();
      this.reveal();
    });
  }

  /** Settle the pending review from the diff editor (CodeLens / title buttons). */
  decide(reviewId: string, indices: number[] | undefined) {
    const p = this.pending;
    if (!p || p.reviewId !== reviewId) return;
    this.pending = undefined;
    p.resolve(indices?.length ? [...new Set(indices)] : undefined);
    this.postState();
  }

  /** Mirror per-hunk decisions made in the diff editor into the review card. */
  hunkStates(reviewId: string, accepted: number[], decided: number[]) {
    void this.view?.webview.postMessage({ type: "hunkStates", reviewId, accepted, decided });
  }

  /** Test hook: accept every hunk of the pending review, as a user clicking "Accept all" would. */
  acceptPendingReview(onlyIfVerified = true): boolean {
    const p = this.pending;
    if (!p) return false;
    const request = this.runs.find(r => r.id === p.runId)?.events.filter(e => e.type === "review.request").at(-1);
    const verified = request?.type === "review.request" && request.verification && request.verification.exitCode === 0 && !request.verification.stale;
    this.pending = undefined;
    // A careful reviewer rejects unverified or failing proposals.
    p.resolve(onlyIfVerified && !verified ? undefined : [...Array(p.count).keys()]);
    this.postState();
    return true;
  }

  get runStatus() { return this.runs.at(-1)?.status; }

  reviewApplied(runId: string, outcome: { applied: boolean; files: string[]; hunks: number }) {
    this.event(runId, { type: "review.result", applied: outcome.applied, files: outcome.files, hunks: outcome.hunks });
  }

  // ---- webview protocol ------------------------------------------------------
  private postState() {
    void this.view?.webview.postMessage({
      type: "state", runs: this.runs, current: this.current, models: this.models, model: this.model, modelError: this.modelError,
      workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? "No folder open", pendingReview: this.pending ? { runId: this.pending.runId, reviewId: this.pending.reviewId } : undefined,
    });
  }

  async refreshModels() {
    if (!this.onRefreshModels) return;
    const { models, error } = await this.onRefreshModels();
    this.models = models;
    this.modelError = error;
    if (!this.models.includes(this.model)) this.model = this.models[0] ?? "";
    this.postState();
  }

  private async receive(raw: unknown) {
    if (!raw || typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string") return;
    const msg = raw as ClientMessage;
    switch (msg.type) {
      case "ready": this.postState(); await this.refreshModels(); break;
      case "models": await this.refreshModels(); break;
      case "model": if (typeof msg.model === "string" && this.models.includes(msg.model)) { this.model = msg.model; await this.context.globalState.update("forge.lastModel", msg.model); } break;
      case "select": if (this.runs.some(r => r.id === msg.runId)) { this.current = msg.runId; this.postState(); } break;
      case "newChat": this.current = undefined; this.postState(); break;
      case "clearHistory": if (!this.busy) { this.runs = []; this.current = undefined; this.saveHistory(); this.postState(); } break;
      case "start": {
        if (typeof msg.task !== "string" || !msg.task.trim() || msg.task.length > 8000) return this.notice("Describe the change you want.");
        if (typeof msg.model !== "string" || !this.models.includes(msg.model)) return this.notice("Choose a model configured in TrueForge.");
        if (this.busy) return this.notice("A run is already in progress. Stop it first.");
        const mentions = Array.isArray(msg.mentions) ? msg.mentions.filter(m => typeof m === "string").slice(0, 20) : [];
        this.model = msg.model;
        const runId = this.startRun("agent", msg.task.trim(), msg.model);
        this.onStart?.({ task: msg.task.trim(), model: msg.model, mentions }, runId);
        break;
      }
      case "stop": if (this.runs.some(r => r.id === msg.runId && r.status === "running")) this.onStop?.(msg.runId); break;
      case "decision": {
        const p = this.pending;
        if (!p || msg.reviewId !== p.reviewId || !Array.isArray(msg.indices)) return;
        const indices = msg.indices.filter(i => Number.isInteger(i) && i >= 0 && i < p.count);
        this.pending = undefined;
        p.resolve(indices.length ? [...new Set(indices)] : undefined);
        this.postState();
        break;
      }
      case "openHunk": if (typeof msg.reviewId === "string" && Number.isInteger(msg.index)) this.onOpenHunk?.(msg.reviewId, msg.index); break;
      case "openFile": {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root || typeof msg.path !== "string" || msg.path.includes("..")) return;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, msg.path)).then(d => d, () => undefined);
        if (!doc) return;
        const line = Math.max(0, (Number(msg.line) || 1) - 1);
        await vscode.window.showTextDocument(doc, { preview: true, selection: new vscode.Range(line, 0, line, 0) });
        break;
      }
      case "openUrl": if (typeof msg.url === "string" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url)); break;
      case "attachFile": { const value = await this.onPickFile?.(); if (value) void this.view?.webview.postMessage({ type: "mention", value }); break; }
      case "attachSymbol": { const value = await this.onPickSymbol?.(); if (value) void this.view?.webview.postMessage({ type: "mention", value }); break; }
      case "undo": { const message = await this.onUndo?.(); if (message) this.notice(message); break; }
      case "toggleHunk": if (this.pending?.reviewId === msg.reviewId && Number.isInteger(msg.index)) this.onToggleHunk?.(msg.reviewId, msg.index, Boolean(msg.accepted)); break;
      case "copy": if (typeof msg.text === "string" && msg.text.length < 50_000) await vscode.env.clipboard.writeText(msg.text); break;
    }
  }

  private notice(text: string) { void this.view?.webview.postMessage({ type: "toast", text }); }

  dispose() { this.pending?.resolve(undefined); if (this.flushTimer) clearTimeout(this.flushTimer); }
}
