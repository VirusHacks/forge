import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import { checkTrueForge } from "./health";
import { runAgent, type AgentSettings } from "./agent/agentRun";
import { Workspace } from "./agent/workspace";
import type { Mentions } from "./agent/retrieval";
import type { UiEvent } from "./core/events";
import { classifyFailure, orderCandidates } from "./core/router";
import { createClient, listModels } from "./core/trueforge";
import { runInlineEdit } from "./inline/inlineEdit";
import { ReviewController } from "./review/reviewController";
import { ForgeSidebar, type StartRequest } from "./ui/sidebar";

const cfg = () => vscode.workspace.getConfiguration("forge");
const baseUrl = () => cfg().get<string>("trueforgeBaseUrl") || process.env.TRUEFORGE_BASE_URL || "http://localhost:8790";

export function readSettings(): AgentSettings {
  const c = cfg();
  return {
    contextBudget: c.get<number>("contextBudget", 0), maxResultChars: c.get<number>("maxToolResultChars", 0),
    maxOutputTokens: c.get<number>("maxOutputTokens", 0), compactAt: c.get<number>("compactionThreshold", 0),
    tightBudgetProviders: c.get<string[]>("tightBudgetProviders", ["groq"]),
    maxModelCalls: c.get<number>("maxModelCalls", 40), iterationLimit: 80,
    allowedCommands: c.get<string[]>("allowedCommands", ["python", "python3", "pytest", "flask", "node", "npm"]),
    python: c.get<string>("pythonPath") || undefined, commandTimeoutMs: c.get<number>("commandTimeoutSeconds", 120) * 1000,
    sandboxCommands: c.get<boolean>("sandboxCommands", true), repoMap: c.get<boolean>("repoMap", true), codeMode: c.get<boolean>("codeMode", false),
    reasoningEffort: c.get<string>("reasoningEffort") || undefined,
    autoVerify: c.get<boolean>("autoVerify", true), verifyCommand: c.get<string>("verifyCommand") || undefined,
    router: { maxSwitches: c.get<number>("maxModelSwitches", 2), maxRetriesPerModel: 2, maxRateLimitWaits: 5, maxRetryDelayMs: 65_000 },
  };
}

/** Plain-language provider failures for notifications (Task C: the user sees a clear message). */
export function friendlyError(message: string): string {
  const kind = classifyFailure(message);
  const hint = {
    network: "TrueForge could not reach the model endpoint",
    invalid_credentials: "The model provider rejected the API key configured in TrueForge",
    rate_limit: "The model provider is rate limiting requests",
    quota: "The model provider's quota is exhausted",
    server: "The model provider is overloaded or failing",
    unavailable: "The configured model is not available",
    context_exceeded: "The request was too large for the model",
    provider_incompatible: "The provider rejected TrueForge's request format",
    malformed_output: "The model produced an invalid tool call",
  }[kind ?? "server"];
  return kind ? `${hint}. No files were changed. Add a fallback in "forge.fallbackModels" or fix the model in TrueForge → Settings → Models.` : message;
}

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Forge", { log: true });
  const sidebar = new ForgeSidebar(context);
  const reviews = new ReviewController(sidebar);
  const running = new Map<string, AbortController>();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "forge.focus";
  const setStatus = (text?: string) => { status.text = text ? `$(sync~spin) Forge: ${text}` : `$(sparkle) Forge${sidebar.selectedModel ? " · " + sidebar.selectedModel.split("/").pop() : ""}`; status.show(); };
  setStatus();
  context.subscriptions.push(output, sidebar, reviews, status, vscode.window.registerWebviewViewProvider("forge.sidebar", sidebar, { webviewOptions: { retainContextWhenHidden: true } }));

  // Every run leaves a JSONL event log (evidence and debugging); deltas are merged.
  const runLogs = vscode.Uri.joinPath(context.globalStorageUri, "runs");
  const writeRunLog = (runId: string, e: UiEvent) => {
    try {
      fs.mkdirSync(runLogs.fsPath, { recursive: true });
      fs.appendFileSync(path.join(runLogs.fsPath, `${runId}.jsonl`), JSON.stringify({ t: Date.now(), ...e }) + "\n");
    } catch { /* logging must never break a run */ }
  };
  const log = (runId: string) => (e: UiEvent) => {
    sidebar.event(runId, e);
    if (e.type !== "assistant.delta" && e.type !== "reasoning.delta") writeRunLog(runId, e);
    if (e.type === "model.switch") void vscode.window.showWarningMessage(`Forge: ${e.from} failed (${e.kind.replace(/_/g, " ")}). Switched automatically to ${e.to}.`);
    if (e.type === "model.retry") setStatus(`retrying in ${Math.ceil(e.delayMs / 1000)}s`);
    if (e.type === "model.call") setStatus(`model call ${e.n}`);
    if (e.type !== "assistant.delta" && e.type !== "reasoning.delta") output.info(JSON.stringify(e).slice(0, 2000));
  };

  sidebar.onRefreshModels = async () => {
    try { const client = await createClient(baseUrl(), 15); return { models: (await listModels(client)).map(m => m.name).sort() }; }
    catch { return { models: [], error: `Cannot reach TrueForge at ${baseUrl()}. Start it with: npx @truefoundry/trueforge@latest` }; }
  };
  sidebar.onStop = runId => running.get(runId)?.abort();
  sidebar.onOpenHunk = (reviewId, index) => void reviews.revealHunk(reviewId, index);
  sidebar.onUndo = () => reviews.undoLast();
  sidebar.onPickFile = async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const pick = await vscode.window.showQuickPick(new Workspace(root).files, { placeHolder: "Mention a file (@file)", matchOnDescription: true });
    return pick;
  };
  sidebar.onPickSymbol = async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const query = await vscode.window.showInputBox({ prompt: "Symbol name to mention (@symbol)", placeHolder: "e.g. FlaskGroup" });
    if (!query?.trim()) return;
    const ws = new Workspace(root), items: vscode.QuickPickItem[] = [];
    for (const file of ws.files) {
      try { for (const s of ws.outline(file)) if (s.name.toLowerCase().includes(query.toLowerCase())) items.push({ label: s.name, description: `${file}:${s.line}`, detail: s.text }); } catch { /* skip */ }
      if (items.length > 200) break;
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Choose the symbol" });
    return pick ? `${pick.description!.split(":")[0]}#${pick.label}:${pick.description!.split(":")[1]}` : undefined;
  };

  async function candidates(primary: string) {
    let available: string[] | undefined;
    try { available = (await listModels(await createClient(baseUrl(), 15))).map(m => m.name); } catch { /* keep configured order */ }
    return orderCandidates(primary, cfg().get<string[]>("fallbackModels", []), available);
  }

  const startAgent = (request: StartRequest, runId: string) => (async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return sidebar.finish(runId, "error", "Open a folder first.");
    const controller = new AbortController();
    running.set(runId, controller);
    try {
      const client = await createClient(baseUrl());
      const mentions: Mentions = { files: [], symbols: [] };
      for (const m of request.mentions) {
        const sym = /^(.+)#(.+):(\d+)$/.exec(m);
        if (sym) mentions.symbols.push({ path: sym[1], name: sym[2], line: Number(sym[3]) }); else mentions.files.push(m);
      }
      // Inline "@path" mentions typed into the request text.
      for (const m of request.task.matchAll(/(?:^|\s)@([\w./-]+\.\w+)/g)) if (!mentions.files.includes(m[1])) mentions.files.push(m[1]);
      const result = await runAgent({
        client, baseUrl: baseUrl(), root, request: request.task, mentions, models: await candidates(request.model),
        settings: readSettings(), signal: controller.signal, emit: log(runId),
        review: proposal => reviews.review(runId, root, { ...proposal, title: request.task }, controller.signal),
      });
      sidebar.finish(runId, result.status, result.status === "error" ? friendlyError(result.message) : result.message);
      if (result.status === "error") void vscode.window.showErrorMessage(`Forge: ${friendlyError(result.message)}`);
    } catch (error) {
      sidebar.finish(runId, controller.signal.aborted ? "cancelled" : "error", controller.signal.aborted ? "Cancelled. No files were changed." : friendlyError(String(error)));
    } finally { running.delete(runId); setStatus(); }
  })();
  sidebar.onStart = (request, runId) => void startAgent(request, runId);

  // Inline edit decoration: highlight the lines being edited while the model works.
  const editing = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor("editor.findRangeHighlightBackground"), isWholeLine: true });
  context.subscriptions.push(editing);

  async function inlineEdit() {
    const editor = vscode.window.activeTextEditor;
    const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!editor || !folder || editor.document.uri.scheme !== "file") return void vscode.window.showWarningMessage("Forge: open a file inside a workspace folder and select the code to edit.");
    if (sidebar.busy) return void vscode.window.showWarningMessage("Forge: a run is already in progress.");
    if (editor.document.isDirty) {
      const ok = await vscode.window.showWarningMessage("Forge edits saved files so the change can be reviewed and undone safely.", "Save and continue");
      if (ok !== "Save and continue" || !await editor.document.save()) return;
    }
    const doc = editor.document, sel = editor.selection;
    let startLine = sel.start.line, endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    const file = path.relative(folder.uri.fsPath, doc.uri.fsPath).split(path.sep).join("/");
    if (sel.isEmpty) {
      const symbol = (() => { try { return new Workspace(folder.uri.fsPath).enclosing(file, sel.start.line + 1); } catch { return undefined; } })();
      if (symbol) { startLine = symbol.line - 1; endLine = symbol.end - 1; }
    }
    const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
    editor.setDecorations(editing, [range]);
    const instruction = await vscode.window.showInputBox({ title: `Forge · edit ${file}:${startLine + 1}-${endLine + 1}`, prompt: "Describe the change in plain language", placeHolder: "e.g. handle empty input and update the docstring", ignoreFocusOut: true });
    if (!instruction?.trim()) { editor.setDecorations(editing, []); return; }
    let model = sidebar.selectedModel;
    if (!model) {
      const models = (await sidebar.onRefreshModels!()).models;
      model = await vscode.window.showQuickPick(models, { placeHolder: "Choose a model configured in TrueForge" }) ?? "";
      if (!model) { editor.setDecorations(editing, []); return; }
    }
    const runId = sidebar.startRun("inline", `${instruction} — ${file}:${startLine + 1}-${endLine + 1}`, model);
    const controller = new AbortController();
    running.set(runId, controller);
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Forge: editing ${path.basename(file)}`, cancellable: true }, async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        const client = await createClient(baseUrl());
        const result = await runInlineEdit({
          client, baseUrl: baseUrl(), root: folder.uri.fsPath, file, languageId: doc.languageId, text: doc.getText(), startLine, endLine, instruction,
          models: await candidates(model!), settings: readSettings(), signal: controller.signal,
          emit: e => { log(runId)(e); if (e.type === "model.call") progress.report({ message: `model call ${e.n} · ${e.model}` }); if (e.type === "review.request") progress.report({ message: "review the diff" }); },
          review: p => { editor.setDecorations(editing, []); return reviews.review(runId, folder.uri.fsPath, { files: [{ path: p.path, base: p.base, next: p.next }], summary: p.explanation, title: instruction }, controller.signal); },
        });
        sidebar.finish(runId, result.status, result.status === "error" ? friendlyError(result.message) : result.message);
        if (result.status === "error") void vscode.window.showErrorMessage(`Forge: ${friendlyError(result.message)}`, "Show details").then(a => a && output.show());
        else if (result.status === "cancelled") void vscode.window.showInformationMessage("Forge: cancelled. The file is unchanged.");
      });
    } finally { editor.setDecorations(editing, []); running.delete(runId); setStatus(); }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.inlineEdit", inlineEdit),
    vscode.commands.registerCommand("forge.stop", () => { for (const c of running.values()) c.abort(); }),
    vscode.commands.registerCommand("forge.undoLastApply", async () => vscode.window.showInformationMessage(`Forge: ${await reviews.undoLast()}`)),
    vscode.commands.registerCommand("forge.focus", () => sidebar.reveal()),
    vscode.commands.registerCommand("forge.environmentStatus", async () => {
      const reachable = await checkTrueForge(baseUrl());
      void vscode.window.showInformationMessage(`Forge: TrueForge ${reachable} at ${baseUrl()} · model ${sidebar.selectedModel || "not selected"}`);
    }),
    { dispose: () => { for (const c of running.values()) c.abort(); } },
  );

  /** Programmatic entry points, used by the extension-host UI tests. */
  return {
    sidebar,
    runAgent: (task: string, model: string) => { sidebar.reveal(); return startAgent({ task, model, mentions: [] }, sidebar.startRun("agent", task, model)); },
    acceptReview: () => sidebar.acceptPendingReview(),
    runLogDirectory: runLogs.fsPath,
    undo: () => reviews.undoLast(),
  };
}

export function deactivate() { /* run controllers are aborted through subscriptions */ }
