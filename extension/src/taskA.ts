import * as vscode from "vscode";
import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { checkTrueForge } from "./health";
import { buildProposedDocument, parseTaskAProposal } from "./patchSafety";
import { WorkspaceMcpServer, type WorkspaceToolCounts } from "./workspaceMcp";

import { registerTaskA, taskARequest } from "./taskAAgent";
import {runTaskAWithFallback} from "./taskAFallback";

interface ActiveTurn {
  client: TrueForgeClient;
  sessionId: string;
  abortController: AbortController;
  cancellationRequested: boolean;
}

type TrueForgeSdkModule = typeof import("@truefoundry/trueforge-sdk");
type TrueForgeClient = InstanceType<TrueForgeSdkModule["TrueForge"]>;

// Keep the extension host CommonJS while loading the SDK through its ESM export.
// The SDK's CommonJS .js entry is interpreted as ESM by its package-level type field.
const importTrueForgeSdk = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<TrueForgeSdkModule>;

interface PendingProposal {
  sourceUri: vscode.Uri;
  originalVersion: number;
  originalDocument: string;
  proposedDocument: string;
  range: vscode.Range;
  replacement: string;
  previewUri: vscode.Uri;
  targetRelativePath: string;
  modelName: string;
  agentName: string;
  sessionId: string;
  turnId: string;
  explanation: string;
  toolCounts: WorkspaceToolCounts;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  retries: number;
  eventCounts: Record<string, number>;
}

export class TaskAController implements vscode.Disposable {
  private activeTurn?: ActiveTurn;
  private activeAbort?: AbortController;
  private pendingProposal?: PendingProposal;
  private cancellationRequested = false;
  private workspaceMcp?: WorkspaceMcpServer;
  private workspaceMcpRoot?: string;
  private workspaceMcpUrl?: string;
  private readonly output = vscode.window.createOutputChannel("Forge Task A");

  private busy = false;
  private applying = false;
  private readonly previews = new Map<string, string>();

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.workspace.registerTextDocumentContentProvider("forge-preview", {
        provideTextDocumentContent: uri => this.previews.get(uri.toString()) ?? "",
      }),      vscode.commands.registerCommand("forge.taskA", () => this.runTaskA()),
      vscode.commands.registerCommand("forge.taskACancel", () => this.cancel()),
      vscode.commands.registerCommand("forge.taskAApprove", () => this.approveProposal()),
      vscode.commands.registerCommand("forge.taskAReject", () => this.rejectProposal()),
    ];
  }

  async runTaskA(): Promise<void> {
    if (this.busy || this.pendingProposal || this.applying) {
      void vscode.window.showWarningMessage("Finish the active Task A run or review first.");
      return;
    }
    this.busy = true;
    this.cancellationRequested = false;
    try {
      await this.propose();
    } finally {
      this.busy = false;
    }
  }

  private async propose(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const root = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!editor || !root) {
      void vscode.window.showWarningMessage("Open a workspace and select get_debug_flag before starting Task A.");
      return;
    }
    if (editor.document.uri.scheme !== "file" || editor.document.isDirty) {
      void vscode.window.showWarningMessage("Save the selected file before proposing a patch.");
      return;
    }
    const startLine = editor.selection.start.line + 1;
    const sourceVersion = editor.document.version;
    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    const complete = editor.document.getText().match(/^def get_debug_flag\([^\n]*\n(?:[ \t]+[^\n]*(?:\n|$))+/m)?.[0];
    if (!complete || complete.trimEnd() !== selectedText.trimEnd()) {
      void vscode.window.showWarningMessage("Select the get_debug_flag function, then run Forge: Task A.");
      return;
    }
    const relativeFile = path.relative(root.uri.fsPath, editor.document.uri.fsPath);
    if (!relativeFile || relativeFile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFile)) {
      void vscode.window.showErrorMessage("The selected function must be inside the current workspace.");
      return;
    }

    const config = vscode.workspace.getConfiguration("forge");
    const baseUrl = config.get<string>("trueforgeBaseUrl", process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790");
    const token = process.env.TRUEFORGE_TOKEN;
    const backend = await checkTrueForge(baseUrl);
    if (backend !== "reachable") {
      void vscode.window.showErrorMessage("TrueForge is unreachable. Start the local server and retry.");
      return;
    }

    let client: TrueForgeClient;
    try {
      const { TrueForge } = await importTrueForgeSdk("@truefoundry/trueforge-sdk");
      client = new TrueForge({
        baseUrl,
        ...(token ? { token } : {}),
        timeoutInSeconds: 600,
        maxRetries: 0,
        stream: { reconnectionEnabled: false, maxReconnectionAttempts: 0 },
      });
    } catch (error) {
      this.logError("load_trueforge_sdk", error);
      void vscode.window.showErrorMessage(`Could not load the TrueForge SDK (${this.errorLabel(error)}).`);
      return;
    }

    let models: Array<{ name: string; modelId: string }>;
    try {
      const response = await client.models.list({ maxRetries: 0 });
      models = response.data;
    } catch (error) {
      this.logError("list_models", error);
      void vscode.window.showErrorMessage(`Could not list TrueForge models (${this.errorLabel(error)}).`);
      return;
    }
    if (models.length === 0) {
      const action = await vscode.window.showInformationMessage(
        "No models are configured in TrueForge. Open TrueForge, configure one under Settings → Models, then run Task A again.",
        "Open TrueForge",
      );
      if (action) await vscode.env.openExternal(vscode.Uri.parse(baseUrl));
      return;
    }

    const configuredModel = config.get<string>("trueforgeModel") || process.env.TRUEFORGE_MODEL;
    let modelName = models.find((model) => model.name === configuredModel)?.name;
    if (!modelName) {
      const picked = await vscode.window.showQuickPick(
        models.map((model) => ({ label: model.name, description: model.modelId })),
        { placeHolder: "Choose a model configured in TrueForge" },
      );
      if (!picked) return;
      modelName = picked.label;
      await config.update("trueforgeModel", modelName, vscode.ConfigurationTarget.Global);
    }

    const abortController = new AbortController();
    this.activeAbort=abortController;
    const agentTag = createHash("sha256").update(root.uri.fsPath).digest("hex").slice(0, 8);
    const mcpName = `forge-workspace-${agentTag}`;
    const agentName = `forge-task-a-${agentTag}`;
    let sessionId: string | undefined;
    let turnId = "unknown";
    let modelCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const eventCounts: Record<string, number> = {};
    let finalText = "";
    let failure: unknown;
    let retryCount = 0;

    this.output.clear();
    this.output.show(true);
    this.output.appendLine(`Task A started via TrueForge. model=${modelName} workspace=${root.uri.fsPath}`);
    this.output.appendLine("Provider calls are made by TrueForge; SDK retries are disabled for this run.");

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "TrueForge: Task A", cancellable: true },
      async (progress, tokenCancellation) => {
        const cancelSubscription = tokenCancellation.onCancellationRequested(() => {
          this.cancellationRequested = true;
          abortController.abort();
          void this.cancel();
        });
        try {
          progress.report({ message: "Starting read-only workspace MCP server" });
          if (this.workspaceMcp && this.workspaceMcpRoot !== root.uri.fsPath) {
            throw new Error("This extension host is already serving another workspace. Open the Task A worktree in its own VS Code window.");
          }
          if (!this.workspaceMcp) {
            const mcpPort = config.get<number>("mcpPort", 8791);
            const mcp = new WorkspaceMcpServer(mcpPort);
            const url = await mcp.start(root.uri.fsPath);
            this.workspaceMcp = mcp;
            this.workspaceMcpUrl = url;
            this.workspaceMcpRoot = root.uri.fsPath;
          }
          if (this.cancellationRequested) return;
          this.workspaceMcp.resetToolCounts();
          const result=await runTaskAWithFallback({client,model:modelName!,agentName,request:taskARequest(relativeFile,selectedText,startLine),signal:abortController.signal,
            fallbackModels:config.get<string[]>("taskAFallbackModels",["google-gemini/gemini-3-5-flash-lite","openrouter/openrouter-free"]),
            availableModels:models.map(m=>m.name),freeOnly:config.get<boolean>("freeOnly",true),providerMaxRetries:config.get<number>("providerMaxRetries",1),
            register:async model=>{if(this.cancellationRequested)throw new Error("Cancelled");this.workspaceMcp?.resetToolCounts();await registerTaskA(client,model,agentName,mcpName,this.workspaceMcpUrl!,root.name,abortController.signal);},
            onSession:id=>{sessionId=id;this.activeTurn={client,sessionId:id,abortController,cancellationRequested:false};this.output.appendLine(`session_id=${id}`);},
            onStatus:e=>{this.output.appendLine(JSON.stringify(e));progress.report({message:String(e.type)});},
            onEvent:event=>{eventCounts[event.type]=(eventCounts[event.type]??0)+1;
              if(event.type==="turn.created")this.output.appendLine(`turn_id=${event.turnId}`);
              if(event.type==="model.message.delta")this.output.append(event.content??"");
              if(event.type==="model.message"&&event.toolCalls?.length)this.output.appendLine(`model_tool_calls=${event.toolCalls.map((c:{function:{name:string}})=>c.function.name).join(",")}`);
            },
          });
          modelName=result.modelName;sessionId=result.sessionId;turnId=result.turnId;finalText=result.finalText;
          modelCalls=result.modelCalls;inputTokens=result.inputTokens;outputTokens=result.outputTokens;retryCount=result.attempts-1;

        } catch (error) {
          failure = error;
        } finally {
          cancelSubscription.dispose();
          this.activeTurn = undefined;
          this.activeAbort = undefined;
        }
      },
    );

    const toolCounts = this.workspaceMcp?.toolCounts ?? { read_file: 0, search_repository: 0 };
    this.output.appendLine("");
    this.output.appendLine(`model_calls=${modelCalls} input_tokens=${inputTokens} output_tokens=${outputTokens} retries=${retryCount}`);
    this.output.appendLine(`mcp_tool_calls=${JSON.stringify(toolCounts)} event_counts=${JSON.stringify(eventCounts)}`);

    if (this.cancellationRequested && !failure) {
      this.output.appendLine("turn_status=cancelled_by_user");
      void vscode.window.showInformationMessage("TrueForge Task A turn cancelled. No patch was applied.");
      return;
    }
    if (failure) {
      if (this.cancellationRequested) {
        this.output.appendLine("turn_status=cancelled_by_user");
        void vscode.window.showInformationMessage("TrueForge Task A turn cancelled. No patch was applied.");
        return;
      }
      const errorLabel = this.errorLabel(failure);
      this.output.appendLine(`turn_error=${errorLabel}`);
      void vscode.window.showErrorMessage(`TrueForge Task A failed (${errorLabel}). See Forge Task A output.`);
      return;
    }
    if (toolCounts.search_repository < 1 || toolCounts.read_file < 1) {
      void vscode.window.showErrorMessage("The agent did not use both required read-only MCP tools; refusing to show a patch.");
      return;
    }
    if (!sessionId || finalText.length === 0) {
      void vscode.window.showErrorMessage("TrueForge returned no final patch response. See Forge Task A output.");
      return;
    }

    try {
      const proposal = parseTaskAProposal(finalText);
      if (editor.document.version !== sourceVersion || editor.document.isDirty) throw new Error("Source changed during the turn. Select it again.");
      const currentText = editor.document.getText();
      const proposedDocument = buildProposedDocument(currentText, selectedText, relativeFile, proposal);
      const previewUri = vscode.Uri.from({ scheme: "forge-preview", path: "/" + relativeFile, query: turnId });
      this.previews.set(previewUri.toString(), proposedDocument);
      await vscode.commands.executeCommand(
        "vscode.diff",
        editor.document.uri,
        previewUri,
        "Forge Task A — review proposed hunk",
      );
      this.pendingProposal = {
        sourceUri: editor.document.uri,
        originalVersion: editor.document.version,
        originalDocument: currentText,
        proposedDocument,
        range: selection,
        replacement: proposedDocument.slice(editor.document.offsetAt(selection.start),
          proposedDocument.length - (currentText.length - editor.document.offsetAt(selection.end))),
        previewUri: previewUri,
        targetRelativePath: relativeFile,
        modelName,
        agentName,
        sessionId,
        turnId,
        explanation: proposal.explanation,
        toolCounts,
        modelCalls,
        inputTokens,
        outputTokens,
        retries: retryCount,
        eventCounts,
      };
      void vscode.window.setStatusBarMessage("Forge Task A patch ready for explicit review", 10_000);
      const pending = this.pendingProposal;
      this.output.appendLine(`review_ready=true session=${sessionId} turn=${turnId}`);
      void vscode.window.showInformationMessage(
        `TrueForge proposed one selected-function hunk: ${proposal.explanation}`,
        "Approve and apply hunk",
        "Reject proposal",
      ).then(async action => {
        if (this.pendingProposal !== pending) return;
        if (action === "Approve and apply hunk") await this.approveProposal();
        else if (action === "Reject proposal") await this.rejectProposal();
      });
    } catch (error) {
      this.output.appendLine(`proposal_validation_error=${this.errorLabel(error)}`);
      void vscode.window.showErrorMessage(`Task A proposal was rejected: ${this.errorLabel(error)}. No file was changed.`);
    }
  }

  async cancel(): Promise<void> {
    if (this.pendingProposal) { await this.rejectProposal(); return; }
    if (this.busy) {this.cancellationRequested = true;this.activeAbort?.abort();}
    const active = this.activeTurn;
    if (!active || active.cancellationRequested) return;
    active.cancellationRequested = true;
    this.cancellationRequested = true;
    this.output.appendLine("Cancellation requested by user.");
    active.abortController.abort();
    try {
      await active.client.sessions.cancel(active.sessionId, {}, { maxRetries: 0 });
    } catch (error) {
      this.logError("cancel_turn", error);
    }
  }

  async approveProposal(): Promise<void> {
    const proposal = this.pendingProposal;
    if (!proposal) {
      void vscode.window.showInformationMessage("There is no pending Forge Task A patch.");
      return;
    }
    if (this.applying) return;
    this.applying = true;
    try {
      await this.apply(proposal);
    } catch (error) {
      this.logError("apply", error);
      void vscode.window.showErrorMessage("Applying the hunk failed. Check the source buffer and Forge Task A output.");
    } finally {
      this.applying = false;
    }
  }

  private async apply(proposal: PendingProposal): Promise<void> {
    const document = await vscode.workspace.openTextDocument(proposal.sourceUri);
    const disk = await readFile(proposal.sourceUri.fsPath, "utf8");
    if (document.isDirty || disk !== proposal.originalDocument || document.version !== proposal.originalVersion || document.getText() !== proposal.originalDocument) {
      await this.closeProposal(proposal);
      void vscode.window.showWarningMessage("The source changed since the preview; the patch was discarded without writing.");
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      proposal.sourceUri,
      proposal.range,
      proposal.replacement,
    );
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      void vscode.window.showErrorMessage("VS Code could not apply the approved hunk. The file was not saved.");
      return;
    }
    if (document.getText() !== proposal.proposedDocument) {
      await this.closeProposal(proposal);
      throw new Error("Buffer changed before save. Review the unsaved document.");
    }
    if (!await document.save()) {
      await this.closeProposal(proposal);
      throw new Error("Save failed. The edit remains in the buffer for inspection.");
    }
    await this.closeProposal(proposal);
    this.output.appendLine(`approved=true file=${proposal.targetRelativePath} agent=${proposal.agentName} session=${proposal.sessionId} turn=${proposal.turnId}`);
    this.output.appendLine(`model=${proposal.modelName} model_calls=${proposal.modelCalls} input_tokens=${proposal.inputTokens} output_tokens=${proposal.outputTokens} retries=${proposal.retries}`);
    this.output.appendLine(`mcp_tool_calls=${JSON.stringify(proposal.toolCounts)} event_counts=${JSON.stringify(proposal.eventCounts)}`);
    void vscode.window.showInformationMessage(`Approved Task A hunk and saved ${proposal.targetRelativePath}. Run the Flask verification script next.`);
  }

  async rejectProposal(): Promise<void> {
    if (!this.pendingProposal || this.applying) return;
    this.output.appendLine(`approved=false rejected file=${this.pendingProposal.targetRelativePath}; no source write performed`);
    await this.closeProposal(this.pendingProposal);
    void vscode.window.showInformationMessage("Task A proposal rejected. The source file was not changed.");
  }

  private async closeProposal(proposal: PendingProposal): Promise<void> {
    this.pendingProposal = undefined;
    const preview = proposal.previewUri.toString();
    for (const group of vscode.window.tabGroups.all) {
      const tab = group.tabs.find(t => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === preview);
      if (tab) await vscode.window.tabGroups.close(tab);
    }
    this.previews.delete(preview);
  }

  dispose(): void {
    void (async () => {
      await this.cancel();
      await this.workspaceMcp?.stop().catch((error) => this.logError("stop_mcp", error));
    })();
    this.output.dispose();
  }

  private logError(operation: string, error: unknown): void {
    this.output.appendLine(`${operation}_error=${this.errorLabel(error)}`);
  }

  private errorLabel(error: unknown): string {
    if (error instanceof Error) {
      const statusCode = (error as Error & { statusCode?: unknown }).statusCode;
      const message = error.message
        .replace(/gsk_[A-Za-z0-9_-]+/g, "[redacted]")
        .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      const status = typeof statusCode === "number" ? ` status=${statusCode}` : "";
      return `${error.name}${status}${message ? `: ${message}` : ""}`;
    }
    return "UnknownError";
  }
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}

