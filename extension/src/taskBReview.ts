import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { renderHunks } from "./taskBContext";
import { isSensitivePath } from "./workspaceMcp";

export interface BHunk {
  path: string;
  original: string;
  replacement: string;
}

export interface TaskBPreview {
  readonly hunk: Readonly<BHunk>;
  readonly line: number;
  readonly before: vscode.Uri;
  readonly after: vscode.Uri;
}

export interface TaskBReviewOptions {
  validate: (selected: BHunk[]) => Promise<{ ok: boolean; summary: string }>;
  approve: (allowed: boolean) => Promise<void>;
  signal: AbortSignal;
  /** Explicit reviewer decision after the diff tabs open. Empty/undefined declines. */
  select?: (previews: readonly TaskBPreview[], signal: AbortSignal) => Promise<readonly number[] | undefined>;
  /** One explicit decision to save all approved files. False keeps every edit unsaved. */
  confirmSave?: (paths: readonly string[], signal: AbortSignal) => Promise<boolean>;
  /** Private extension storage for rollback journals if a multi-file save cannot be restored. */
  recoveryDirectory?: string;
  /** Save adapter used by editor-host tests; production uses TextDocument.save(). */
  saveDocument?: (doc: vscode.TextDocument) => Promise<boolean>;
}

interface Source {
  file: string;
  stat: BigIntStats;
  bytes: Buffer;
  text: string;
  doc: vscode.TextDocument;
  version: number;
}

function target(root: string, name: string): string {
  const parts = name.split("/");
  if (/[\\:\x00-\x1f\x7f]/.test(name) || isSensitivePath(name) ||
      parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) {
    throw new Error(`Unsafe review path: ${name}`);
  }
  return path.join(root, ...parts);
}

function sameRevision(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function diskSnapshot(file: string) {
  if (await realpath(file) !== file) throw new Error(`Symlink or aliased path: ${file}`);
  const entry = await lstat(file, { bigint: true });
  if (!entry.isFile() || entry.nlink !== 1n) throw new Error(`Expected an unlinked regular file: ${file}`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!sameRevision(entry, stat)) throw new Error(`File changed before read: ${file}`);
    const bytes = await handle.readFile();
    if (await realpath(file) !== file || !sameRevision(stat, await lstat(file, { bigint: true }))) {
      throw new Error(`File changed during read: ${file}`);
    }
    return { stat, bytes };
  } finally {
    await handle.close();
  }
}

async function sourceFor(file: string, base: string): Promise<Source> {
  const { bytes, stat } = await diskSnapshot(file);
  const raw = bytes.toString("utf8");
  const text = raw.replace(/^\uFEFF/, "");
  if (text.includes("\0") || !Buffer.from(raw).equals(bytes) || (raw !== base && text !== base)) {
    throw new Error(`Expected the UTF-8 review snapshot on disk: ${file}`);
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  if (doc.isClosed || doc.isDirty || doc.getText() !== text) throw new Error(`Expected a clean matching buffer: ${file}`);
  return { file, stat, bytes, text, doc, version: doc.version };
}

async function checkDisk(source: Source) {
  const { stat, bytes } = await diskSnapshot(source.file);
  if (!sameRevision(stat, source.stat) || !bytes.equals(source.bytes)) {
    throw new Error(`File changed since review: ${source.file}`);
  }
}

async function checkSources(sources: Source[], signal: AbortSignal) {
  await Promise.all(sources.map(checkDisk));
  for (const { doc, text, version, file } of sources) {
    if (doc.isClosed || doc.isDirty || doc.version !== version || doc.getText() !== text) {
      throw new Error(`Buffer changed since review: ${file}`);
    }
    if (vscode.workspace.getConfiguration("files", doc).get("autoSave", "off") !== "off") {
      throw new Error(`Turn off Auto Save for ${file} to review and save it separately.`);
    }
  }
  signal.throwIfAborted();
}

function rangeOf(source: Source, hunk: BHunk): vscode.Range {
  const start = source.text.indexOf(hunk.original);
  const end = start + hunk.original.length;
  const range = new vscode.Range(source.doc.positionAt(start), source.doc.positionAt(end));
  const eol = source.doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  if (source.doc.getText(range) !== hunk.original ||
      hunk.replacement.replace(/\r\n|\r|\n/g, eol) !== hunk.replacement ||
      hunk.replacement.includes("\0") || Buffer.from(hunk.replacement).toString() !== hunk.replacement ||
      [start, end].some(offset => /[\uD800-\uDBFF]/.test(source.text.charAt(offset - 1)) &&
        /[\uDC00-\uDFFF]/.test(source.text.charAt(offset)))) {
    throw new Error(`Hunk cannot be represented exactly in the editor: ${hunk.path}`);
  }
  return range;
}

// Also lets cancellation settle a pending notification or injected reviewer.
function interruptible<T>(signal: AbortSignal, operation: () => PromiseLike<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function selectInEditor(previews: readonly TaskBPreview[], signal: AbortSignal) {
  const action = await vscode.window.showInformationMessage(
    "Review the Task B diff tabs, then choose the hunks to apply.", "Choose hunks", "Reject proposal");
  if (action !== "Choose hunks" || signal.aborted) return;
  const cancel = new vscode.CancellationTokenSource();
  const onAbort = () => cancel.cancel();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const picks = await vscode.window.showQuickPick(previews.map(({ hunk, line }, index) => ({
      label: `Hunk ${index + 1} · ${hunk.path}:${line}`, index,
      description: hunk.original.split(/\r?\n/)[0].slice(0, 90),
    })), {
      title: "Approve selected Task B hunks",
      placeHolder: "Check hunks and press Enter to approve. Escape cancels.",
      canPickMany: true, ignoreFocusOut: true,
    }, cancel.token);
    return picks?.map(item => item.index);
  } finally {
    signal.removeEventListener("abort", onAbort);
    cancel.dispose();
  }
}

async function askToSave(paths: readonly string[]) {
  const answer = await vscode.window.showInformationMessage(
    `Save the approved Task B changes to all ${paths.length} files?`, "Save all files", "Keep all unsaved");
  return answer === "Save all files";
}

async function replaceDocumentText(source: Source, text: string) {
  if (source.doc.isClosed) throw new Error(`Document closed during save recovery: ${source.file}`);
  const current = source.doc.getText();
  if (current === text) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(source.doc.uri, new vscode.Range(source.doc.positionAt(0), source.doc.positionAt(current.length)), text);
  if (!await vscode.workspace.applyEdit(edit)) throw new Error(`VS Code declined recovery edit: ${source.file}`);
}

async function writeRecoveryJournal(root: string, plans: Map<string, { source: Source; expected: string }>, directory?: string) {
  if (!directory) return undefined;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const files = [...plans].map(([name, { source, expected }]) => {
    const bom = source.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "\uFEFF" : "";
    return { path: name, originalBase64: source.bytes.toString("base64"), proposedBase64: Buffer.from(bom + expected).toString("base64") };
  });
  const record = { version: 1, root, createdAt: new Date().toISOString(), status: "prepared", files };
  const journal = path.join(directory, `task-b-${Date.now()}-${randomUUID()}.json`);
  const temporary = journal + ".tmp";
  await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, journal);
  return journal;
}

async function offerSaves(root: string, plans: Map<string, { source: Source; expected: string }>, opts: TaskBReviewOptions) {
  const names = [...plans.keys()];
  const versions = new Map([...plans].map(([name, { source }]) => [name, source.doc.version]));
  try {
    const confirm = opts.confirmSave ?? askToSave;
    if (await interruptible(opts.signal, () => confirm(names, opts.signal)) !== true) return;
    for (const [name, { source, expected }] of plans) {
      await checkDisk(source);
      if (source.doc.isClosed || !source.doc.isDirty || source.doc.version !== versions.get(name) || source.doc.getText() !== expected) {
        throw new Error(`The approved buffer changed before save: ${name}`);
      }
      if (vscode.workspace.getConfiguration("files", source.doc).get("autoSave", "off") !== "off") {
        throw new Error(`Turn off Auto Save for ${name} to save the reviewed transaction.`);
      }
    }
    opts.signal.throwIfAborted();
    const journal = await writeRecoveryJournal(root, plans, opts.recoveryDirectory);
    try {
      for (const [name, { source, expected }] of plans) {
        opts.signal.throwIfAborted();
        await checkDisk(source);
        if (source.doc.isClosed || !source.doc.isDirty || source.doc.version !== versions.get(name) || source.doc.getText() !== expected) {
          throw new Error(`The approved buffer changed during save: ${name}`);
        }
        const saved = await (opts.saveDocument ? opts.saveDocument(source.doc) : source.doc.save());
        if (!saved) throw new Error(`VS Code declined the save: ${name}`);
        const { bytes } = await diskSnapshot(source.file);
        const bom = source.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "\uFEFF" : "";
        if (source.doc.isDirty || source.doc.getText() !== expected || !bytes.equals(Buffer.from(bom + expected))) {
          throw new Error(`The saved contents differ from the approved edit: ${name}`);
        }
      }
      if (journal) await rm(journal, { force: true });
    } catch (saveError) {
      const failures: string[] = [];
      // Restore only files that still contain our approved bytes; preserve concurrent edits.
      for (const [name, { source, expected }] of [...plans].reverse()) {
        const bom = source.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "\uFEFF" : "";
        const proposedBytes = Buffer.from(bom + expected);
        try {
          const disk = await diskSnapshot(source.file);
          if (disk.bytes.equals(source.bytes)) continue;
          if (!disk.bytes.equals(proposedBytes)) throw new Error("Disk differs from both the original and approved contents.");
          if (source.doc.getText() !== expected || source.doc.isClosed) throw new Error("The editor buffer changed during rollback.");
          await replaceDocumentText(source, source.text);
          if (!await source.doc.save()) throw new Error("VS Code declined the rollback save.");
          const restored = await diskSnapshot(source.file);
          if (!restored.bytes.equals(source.bytes)) throw new Error("Restored bytes do not match the original.");
        } catch (rollbackError) {
          failures.push(`${name}: ${String(rollbackError)}`);
        }
      }
      // Keep the entire reviewed proposal visible as unsaved buffers after a successful rollback.
      for (const { source, expected } of plans.values()) {
        try { await replaceDocumentText(source, expected); }
        catch (rollbackError) { failures.push(`${source.file} buffer: ${String(rollbackError)}`); }
      }
      if (journal) {
        if (failures.length) {
          try {
            const record = JSON.parse(await readFile(journal, "utf8"));
            record.status = "recovery_required";
            record.saveError = String(saveError).slice(0, 500);
            record.rollbackErrors = failures.slice(0, 12);
            await writeFile(journal, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
          } catch (journalError) { failures.push(`recovery journal: ${String(journalError)}`); }
        } else {
          await rm(journal, { force: true });
        }
      }
      const recovery = journal && failures.length ? ` Recovery data: ${journal}` : " Disk changes were rolled back; the complete proposal remains unsaved in the editor.";
      void vscode.window.showWarningMessage(`Task B could not save the approved files as one transaction. ${String(saveError)}${recovery}`);
    }
  } catch (error) {
    if (!opts.signal.aborted) void vscode.window.showWarningMessage(`Task B edits remain unsaved. ${String(error)}`);
  }
}

/**
 * Review existing UTF-8 files under root. `applied` describes the editor-buffer transaction.
 * Disk saving requires one explicit all-files choice and compensates earlier saves if a later save fails.
 * Cancellation before commit returns an empty selection. Unsafe, stale, incoherent transactions reject.
 */
export async function reviewTaskB(root: string, hunks: BHunk[], base: Record<string, string>, opts: TaskBReviewOptions):
    Promise<{ applied: boolean; selected: BHunk[] }> {
  const declined = { applied: false, selected: [] };
  let decisionSent = false;
  const scheme = "forge-taskb-" + randomUUID();
  const contents = new Map<string, string>();
  let provider: vscode.Disposable | undefined;
  try {
    opts.signal.throwIfAborted();
    const input = hunks.map(h => Object.freeze({ path: h.path, original: h.original, replacement: h.replacement }));
    if (!input.length) return declined;
    const bases = new Map(Object.entries(base));
    if (!path.isAbsolute(root) || !(await lstat(root)).isDirectory()) throw new Error("Expected a real workspace directory.");
    const directory = await realpath(root);
    const sources = new Map<string, Source>();
    const identities = new Set<string>();
    const previews: TaskBPreview[] = [];
    for (const [index, hunk] of input.entries()) {
      opts.signal.throwIfAborted();
      let source = sources.get(hunk.path);
      if (!source) {
        const file = target(directory, hunk.path);
        const original = bases.get(hunk.path);
        if (typeof original !== "string") throw new Error(`Missing review base for ${hunk.path}`);
        source = await sourceFor(file, original);
        const identity = `${source.stat.dev}:${source.stat.ino}`;
        if (identities.has(identity)) throw new Error(`Aliased review target: ${file}`);
        identities.add(identity);
        sources.set(hunk.path, source);
      }
      const proposed = renderHunks(source.text, [hunk]);
      const range = rangeOf(source, hunk);
      const before = vscode.Uri.from({ scheme, path: "/" + hunk.path, query: "base" });
      const after = before.with({ query: String(index) });
      contents.set(before.toString(), source.text);
      contents.set(after.toString(), proposed);
      previews.push(Object.freeze({ hunk, line: range.start.line + 1, before, after }));
    }
    provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent: uri => contents.get(uri.toString()),
    });
    for (const [i, p] of previews.entries()) {
      opts.signal.throwIfAborted();
      await vscode.commands.executeCommand("vscode.diff", p.before, p.after,
        `Task B · hunk ${i + 1} · ${p.hunk.path}:${p.line}`, { preview: false });
    }
    const select = opts.select ?? selectInEditor;
    const indices = await interruptible(opts.signal, () => select(Object.freeze(previews), opts.signal));
    if (!indices?.length) return declined;
    const picks = new Set(indices);
    if (picks.size !== indices.length || [...picks].some(i => !Number.isInteger(i) || i < 0 || i >= input.length)) {
      throw new Error("Invalid hunk selection.");
    }
    const selected = input.filter((_, i) => picks.has(i));
    const plans = new Map<string, { source: Source; expected: string }>();
    const edit = new vscode.WorkspaceEdit();
    for (const name of new Set(selected.map(h => h.path))) {
      const source = sources.get(name)!;
      const group = selected.filter(h => h.path === name);
      plans.set(name, { source, expected: renderHunks(source.text, group) });
      for (const hunk of group) edit.replace(source.doc.uri, rangeOf(source, hunk), hunk.replacement);
    }
    const targets = [...plans.values()].map(p => p.source);
    const validate = async () => {
      const verdict = await opts.validate([...selected]);
      opts.signal.throwIfAborted();
      if (verdict.ok !== true) throw new Error(`Selected hunks failed validation: ${verdict.summary}`);
    };
    await checkSources(targets, opts.signal);
    await validate();
    await checkSources(targets, opts.signal);
    decisionSent = true;
    await opts.approve(true);
    await checkSources(targets, opts.signal);
    await validate();
    await checkSources(targets, opts.signal);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code declined the Task B edit.");
    await offerSaves(directory, plans, opts);
    return { applied: true, selected };
  } catch (error) {
    if (opts.signal.aborted) return declined;
    throw error;
  } finally {
    try {
      if (!decisionSent) await opts.approve(false);
    } finally {
      if (provider) {
        const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs.filter(t =>
          t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === scheme));
        try {
          if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
        } finally {
          provider.dispose();
        }
      }
    }
  }
}
