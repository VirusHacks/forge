import * as vscode from "vscode";
import { checkTrueForge } from "./health";
import { registerTaskB } from "./taskB";
import { TaskAController } from "./taskA";
import {ForgeSidebar} from "./forgeSidebar";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const disposable = vscode.commands.registerCommand("forge.environmentStatus", async () => {
    const editor = vscode.window.activeTextEditor;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    const configuredUrl = vscode.workspace
      .getConfiguration("forge")
      .get<string>("trueforgeBaseUrl", process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790");
    const backend = await checkTrueForge(configuredUrl);
    const activeFile = editor?.document.uri.fsPath ?? "none";
    const message = [
      "Forge extension loaded",
      `workspace=${workspace?.uri.fsPath ?? "none"}`,
      `activeFile=${activeFile}`,
      `trueforge=${backend} (${configuredUrl})`,
    ].join(" | ");
    void vscode.window.showInformationMessage(message);
  });

  const sidebar=new ForgeSidebar(context);
  context.subscriptions.push(sidebar,vscode.window.registerWebviewViewProvider("forge.sidebar",sidebar));
  sidebar.setStart(run=>{void vscode.commands.executeCommand("forge.taskB",run);});
  registerTaskB(context,sidebar);
  const taskA = new TaskAController();
  context.subscriptions.push(disposable, taskA, ...taskA.registerCommands());
}

export function deactivate(): void {
  // No long-lived resources in the Phase 0 scaffold.
}

