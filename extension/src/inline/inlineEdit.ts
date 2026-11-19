import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { UiEvent } from "../core/events";
import { profileFor } from "../core/profiles";
import { ModelRouter, redact } from "../core/router";
import { runSession } from "../core/session";
import { upsertAgent, upsertMcpServer, type TrueForgeClient } from "../core/trueforge";
import { WorkspaceMcpServer } from "../workspaceMcp";
import { connectorName, type AgentSettings, type ReviewOutcome } from "../agent/agentRun";
import { AgentTools } from "../agent/tools";
import { Workspace } from "../agent/workspace";

/**
 * Inline edit: the user selects lines, presses the keybinding and types an instruction.
 * The model receives the selection plus nearby context and answers by calling
 * `propose_edit`, an approval-gated MCP tool. TrueForge's approval request drives the
 * per-hunk diff review; nothing is written unless hunks are accepted.
 */
export const INLINE_AGENT = "forge-inline";
export const INLINE_TOOLS = ["propose_edit", "read_code", "search_code"];

export const INLINE_INSTRUCTIONS = `You are Forge's inline code editor. The user selected lines in a file and gave an instruction.
Call propose_edit with "replacement": the COMPLETE new text of the selected lines — every selected line from the first to the last, rewritten as needed (keep indentation; nothing outside the selection) — and a one-sentence "explanation".
Use read_code or search_code only if the given context is insufficient. Keep unrelated code unchanged. Do not paste the code in chat.`;

export interface InlineRequest {
  client: TrueForgeClient; baseUrl: string; root: string; file: string; languageId: string;
  text: string; startLine: number; endLine: number; instruction: string;
  models: string[]; settings: AgentSettings; signal: AbortSignal; emit: (e: UiEvent) => void;
  review: (proposal: { path: string; base: string; next: string; explanation?: string }) => Promise<ReviewOutcome>;
}

export function buildInlineSpec(model: string, connector: string, s: AgentSettings) {
  const p = profileFor(model, s, s.tightBudgetProviders);
  return {
    model: { name: model, params: { maxTokens: p.name === "tight" ? p.maxOutputTokens : Math.max(2048, Math.min(p.maxOutputTokens, 8192)) } },
    instructions: INLINE_INSTRUCTIONS,
    config: {
      iterationLimit: 6, sandbox: { enabled: false }, webSearch: { enabled: false }, askUserQuestions: { enabled: false },
      generativeUi: { enabled: false }, dynamicSubAgents: { enabled: false },
      contextManagement: { compaction: { enabled: false }, largeToolResponse: { enabled: true } },
    },
    mcpServers: [{ name: connector, enableTools: INLINE_TOOLS, preload: true, requireApprovalForTools: ["propose_edit"] }],
  };
}

/** Selection plus bounded surrounding context. Lines are 0-based and inclusive. */
export function inlinePrompt(r: Pick<InlineRequest, "file" | "languageId" | "text" | "startLine" | "endLine" | "instruction">) {
  const lines = r.text.split("\n");
  const fence = (from: number, to: number) => "```" + r.languageId + "\n" + lines.slice(from, to).join("\n") + "\n```";
  const before = Math.max(0, r.startLine - 30), after = Math.min(lines.length, r.endLine + 1 + 15);
  return [
    `Instruction: ${r.instruction.trim()}`,
    `File: ${r.file} (${r.languageId})`,
    `Selected lines ${r.startLine + 1}-${r.endLine + 1} — your replacement replaces exactly these lines:`,
    fence(r.startLine, r.endLine + 1),
    r.startLine > 0 ? `Context before (lines ${before + 1}-${r.startLine}, read-only):\n${fence(before, r.startLine)}` : "",
    r.endLine + 1 < lines.length ? `Context after (lines ${r.endLine + 2}-${after}, read-only):\n${fence(r.endLine + 1, after)}` : "",
  ].filter(Boolean).join("\n\n");
}

/** Replace the selected full lines with the model's replacement, preserving the trailing newline. */
export function applySelection(text: string, startLine: number, endLine: number, replacement: string): string {
  const lines = text.split("\n");
  const selected = lines.slice(startLine, endLine + 1).join("\n");
  let next = replacement.replace(/\r\n/g, "\n");
  if (selected.endsWith("\n") !== next.endsWith("\n")) next = selected.endsWith("\n") ? next + "\n" : next.replace(/\n$/, "");
  next = next.replace(/\n$/, "");
  return [...lines.slice(0, startLine), ...next.split("\n"), ...lines.slice(endLine + 1)].join("\n");
}

/**
 * Model-independent sanity checks on a proposed replacement. A problem is sent back to the
 * model as the approval denial reason so it can correct itself in the same turn.
 */
export function checkReplacement(selected: string, replacement: string, instruction: string): string | undefined {
  const sel = selected.split("\n"), rep = replacement.replace(/\n$/, "").split("\n");
  const firstLine = sel.find(l => l.trim()) ?? "";
  const def = /^\s*(?:async\s+)?(?:def|class|function|func|fn)\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(firstLine);
  const removing = /\b(remove|delete|drop|shorten|simplif|collapse|inline|replace (?:it|this) with)\b/i.test(instruction);
  if (def && !removing && !replacement.includes(def[1] ?? def[2])) {
    return `Your replacement must be the complete rewritten selection, starting with the definition line \`${firstLine.trim()}\` and including its whole body. Call propose_edit again with all ${sel.length} selected lines rewritten.`;
  }
  if (!removing && sel.length >= 4 && rep.length < sel.length * 0.5) {
    return `The replacement has ${rep.length} lines but the selection has ${sel.length}; it looks truncated. Call propose_edit again with every selected line (rewritten as needed).`;
  }
  return undefined;
}

/** Accept an edit given in prose when a model does not call the tool (model independence). */
export function replacementFromText(text: string): { replacement: string; explanation?: string } | undefined {
  const json = /\{[\s\S]*"replacement(?:Text)?"[\s\S]*\}/.exec(text);
  if (json) {
    try { const v = JSON.parse(json[0]); const r = v.replacement ?? v.replacementText; if (typeof r === "string" && r.trim()) return { replacement: r, explanation: v.explanation }; } catch { /* fall through */ }
  }
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]);
  const longest = blocks.sort((a, b) => b.length - a.length)[0];
  return longest?.trim() ? { replacement: longest.replace(/\n$/, "") } : undefined;
}

export async function runInlineEdit(request: InlineRequest): Promise<{ status: "complete" | "rejected" | "error" | "cancelled"; message: string }> {
  const t0 = Date.now();
  let modelCalls = 0, inputTokens = 0, outputTokens = 0;
  const r: InlineRequest = { ...request, emit: e => {
    if (e.type === "model.call") modelCalls++;
    if (e.type === "usage") { inputTokens += e.inputTokens; outputTokens += e.outputTokens; }
    request.emit(e);
  } };
  const ws = new Workspace(r.root);
  const profile = profileFor(r.models[0], r.settings, r.settings.tightBudgetProviders);
  const tools = new AgentTools(ws, undefined, { maxResultChars: profile.maxResultChars, allowedCommands: [], commandTimeoutMs: 1, sandboxCommands: true }, r.emit, r.signal);
  let outcome: ReviewOutcome | undefined;
  let explanation = "", corrections = 0;
  const review = async (replacement: string) => {
    const next = applySelection(r.text, r.startLine, r.endLine, replacement);
    if (next === r.text) throw new Error("The model proposed no change.");
    outcome = await r.review({ path: r.file, base: r.text, next, explanation });
    return outcome;
  };
  const mcp = new WorkspaceMcpServer(0, () => tools.createServer(server => {
    server.registerTool("propose_edit", {
      description: "Propose the replacement for the selected lines. The user reviews it as a diff; requires approval.",
      inputSchema: { replacement: z.string().max(60000), explanation: z.string().max(600).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, () => tools.wrap("propose_edit", "Propose edit", () => tools.reviewOutcome ?? "Proposal received."));
  }), "/mcp/" + randomBytes(18).toString("hex"));
  const router = new ModelRouter(r.models, r.settings.router);
  try {
    const url = await mcp.start(ws.root);
    const connector = connectorName(ws.root) + "-inline";
    await upsertMcpServer(r.client, connector, url, "Forge inline-edit tools");
    const spec = (model: string) => buildInlineSpec(model, connector, r.settings);
    await upsertAgent(r.client, INLINE_AGENT, "Forge inline edit: selection + instruction → approval-gated propose_edit → per-hunk diff.", spec(router.current), r.signal);
    const result = await runSession({
      client: r.client, baseUrl: r.baseUrl, agentName: INLINE_AGENT, buildSpec: spec, router, title: `Inline: ${r.instruction}`,
      input: inlinePrompt(r), signal: r.signal, emit: r.emit, maxModelCalls: 6, ownTools: INLINE_TOOLS,
      continuation: "Continue: call propose_edit with the replacement for the selected lines.",
      onApproval: async request => {
        if (request.toolName !== "propose_edit" || typeof request.arguments.replacement !== "string") return { allow: false, reason: "Call propose_edit with a replacement string." };
        explanation = String(request.arguments.explanation ?? "");
        const selected = r.text.split("\n").slice(r.startLine, r.endLine + 1).join("\n");
        const problem = checkReplacement(selected, request.arguments.replacement, r.instruction);
        if (problem && corrections < 2) {
          corrections++;
          r.emit({ type: "notice", level: "warning", message: `Proposal rejected automatically: ${problem.split(". ")[0]}. Asking the model to correct it.` });
          return { allow: false, reason: problem };
        }
        const o = await review(request.arguments.replacement);
        tools.reviewOutcome = o.applied ? "The user accepted the edit. Done." : "The user rejected the edit.";
        return { allow: o.applied, reason: o.applied ? undefined : "The user rejected the edit.", finish: true };
      },
    });
    if (!outcome) {
      const parsed = replacementFromText(result.finalText);
      if (!parsed) return { status: "error", message: "The model did not propose an edit. Try again or choose another model." };
      explanation = parsed.explanation ?? "";
      r.emit({ type: "notice", level: "info", message: "The model replied in text instead of calling propose_edit; Forge extracted the edit for review." });
      await review(parsed.replacement);
    }
    return outcome!.applied ? { status: "complete", message: `Applied ${outcome!.selected.length} hunk(s) to ${r.file}.` } : { status: "rejected", message: "Edit rejected; the file is unchanged." };
  } catch (error) {
    if (r.signal.aborted) return { status: "cancelled", message: "Cancelled. The file is unchanged." };
    return { status: "error", message: redact(error instanceof Error ? error.message : String(error)) };
  } finally {
    await mcp.stop().catch(() => undefined);
    tools.dispose();
    r.emit({ type: "metrics", metrics: { modelCalls, toolCalls: tools.totalCalls, inputTokens, outputTokens, ms: Date.now() - t0, models: [...router.used] } });
  }
}
