import path from "node:path";

export interface TaskAProposal {
  path: string;
  originalText: string;
  replacementText: string;
  explanation: string;
}

export function buildProposedDocument(
  source: string,
  selectedText: string,
  targetPath: string,
  proposal: TaskAProposal,
): string {
  if (path.normalize(proposal.path) !== path.normalize(targetPath)) {
    throw new Error("The proposed patch targets a different file than the selected function.");
  }
  const selected = selectedText.replace(/(?:\r?\n)+$/, "");
  const original = proposal.originalText.replace(/(?:\r?\n)+$/, "");
  if (original !== selected || !/^def get_debug_flag\(/.test(selected)) {
    throw new Error("The proposed original must match exactly the selected function.");
  }
  if (!isUniqueSubstring(source, selected)) throw new Error("Selection must be a unique exact match.");
  const replacement = proposal.replacementText.replace(/(?:\r?\n)+$/, "");
  if (replacement === selected) throw new Error("The proposal contains no changes.");
  const offset = source.indexOf(selected);
  return source.slice(0, offset) + replacement + source.slice(offset + selected.length);
}

export function parseTaskAProposal(text: string): TaskAProposal {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(normalized);
  if (!parsed || typeof parsed !== "object") throw new Error("The final response is not a JSON object.");
  const value = parsed as Record<string, unknown>;
  if (typeof value.path !== "string" || typeof value.originalText !== "string" ||
      typeof value.replacementText !== "string" || typeof value.explanation !== "string") {
    throw new Error("The final response is missing required patch fields.");
  }
  if (!value.originalText || !value.replacementText) throw new Error("The proposed source or replacement is empty.");
  return {
    path: value.path,
    originalText: value.originalText,
    replacementText: value.replacementText,
    explanation: value.explanation,
  };
}

function isUniqueSubstring(source: string, snippet: string): boolean {
  const first = source.indexOf(snippet);
  return first >= 0 && source.indexOf(snippet, first + snippet.length) < 0;
}
