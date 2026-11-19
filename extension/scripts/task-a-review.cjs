// Entry point for --extensionTestsPath in a disposable VS Code development host.
const vscode = require("vscode");
const assert = require("node:assert/strict");

exports.run = async () => {
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.equal(root?.uri.fsPath, process.env.FLASK_TASK_A_REPO);
  const config = vscode.workspace.getConfiguration("forge");
  // This launcher uses a separate --user-data-dir and an unoccupied MCP port.
  assert.ok(process.env.FORGE_REVIEW_PORT && process.env.TRUEFORGE_MODEL);
  await config.update("mcpPort", Number(process.env.FORGE_REVIEW_PORT), vscode.ConfigurationTarget.Global);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root.uri, "src/flask/helpers.py"));
  const initial = doc.getText();
  const match = initial.match(/^def get_debug_flag\([^\n]*\n(?:[ \t]+[^\n]*\n)+/m);
  assert.ok(match);
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(doc.positionAt(match.index), doc.positionAt(match.index + match[0].length));
  editor.revealRange(editor.selection);
  await vscode.commands.executeCommand("forge.taskA");
  const review = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(t =>
    t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === "forge-preview");
  assert.ok(review, "No review diff opened. See Forge Task A output.");
  assert.equal(doc.getText(), initial);
  assert.equal(doc.isDirty, false);
  const proposed = await vscode.workspace.openTextDocument(review.input.modified);
  const selected = proposed.getText().match(/^def get_debug_flag\([^\n]*\n(?:[ \t]*\n|[ \t]+[^\n]*\n)+/m)?.[0];
  console.log("TASK_A_REVIEW", JSON.stringify({turn: review.input.modified.query, selected}));
  // Leave the actual diff and approval controls available until the reviewer closes it.
  await new Promise(resolve => {
    const subscription = vscode.window.tabGroups.onDidChangeTabs(event => {
      if (event.closed.some(t => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === review.input.modified.toString())) {
        subscription.dispose();
        resolve();
      }
    });
  });
};
