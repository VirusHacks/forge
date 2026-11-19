import { ModelRouter, redact } from "./router";
import { sessionUrl, type AgentSpec, type TrueForgeClient } from "./trueforge";
import type { UiEvent } from "./events";

/**
 * Runs one TrueForge session to completion.
 *
 * - Streams text, reasoning, tool-call and compaction events to the UI.
 * - On a provider failure, asks the ModelRouter whether to wait and retry or to switch
 *   models. A switch updates the session's agent spec and continues the *same* session
 *   from the last turn, so earlier tool results stay in TrueForge's history.
 * - Tool approvals (TrueForge's `requireApprovalForTools`) are handed to `onApproval`,
 *   which drives the editor's diff review.
 */
export interface ApprovalRequest { toolName: string; toolCallId: string; arguments: Record<string, unknown> }
export interface ApprovalDecision { allow: boolean; reason?: string; /** Stop the turn after this decision to save model calls. */ finish?: boolean }

export interface SessionRunOptions {
  client: TrueForgeClient;
  baseUrl: string;
  agentName: string;
  buildSpec: (model: string) => AgentSpec;
  router: ModelRouter;
  title: string;
  input: string;
  signal: AbortSignal;
  emit: (event: UiEvent) => void;
  onApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  maxModelCalls?: number;
  /** Forge's own MCP tool names; any other tool call is a TrueForge harness action and is surfaced. */
  ownTools?: string[];
  /** Text sent when a turn is continued after a provider failure. */
  continuation?: string;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface SessionRunResult {
  sessionId: string;
  finalText: string;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  models: string[];
  finishedEarly: boolean;
}

const defaultWait = (ms: number, signal: AbortSignal) =>
  import("node:timers/promises").then(({ setTimeout }) => setTimeout(ms, undefined, { signal }));

class TurnFailure extends Error {}

export async function runSession(o: SessionRunOptions): Promise<SessionRunResult> {
  const wait = o.wait ?? defaultWait;
  const maxCalls = o.maxModelCalls ?? 30;
  o.signal.throwIfAborted();

  // An inline spec (rather than a named-agent reference) lets fallback swap the model mid-session.
  const created = await o.client.sessions.create({ agent: { spec: o.buildSpec(o.router.current) }, metadata: { agent: o.agentName } } as any, { maxRetries: 0 })
    .catch(() => o.client.sessions.create({ agent: { spec: o.buildSpec(o.router.current) } } as any, { maxRetries: 0 }));
  const sessionId: string = (created as any).data.id;
  await o.client.sessions.update(sessionId, { title: o.title.slice(0, 120) } as any, { maxRetries: 0 }).catch(() => undefined);
  o.emit({ type: "session", sessionId, url: sessionUrl(o.baseUrl, sessionId), agent: o.agentName, model: o.router.current });

  const cancel = () => { void o.client.sessions.cancel(sessionId, {}, { maxRetries: 0 }).catch(() => undefined); };
  o.signal.addEventListener("abort", cancel, { once: true });

  let previousTurnId: string | undefined;
  let input = o.input;
  let modelCalls = 0, completed = 0, inputTokens = 0, outputTokens = 0, toolActivity = 0;
  let finalText = "", finishedEarly = false;

  try {
    for (;;) {
      o.signal.throwIfAborted();
      try {
        const outcome = await streamTurn();
        finalText = outcome.text;
        finishedEarly = outcome.finishedEarly;
        return { sessionId, finalText, modelCalls, inputTokens, outputTokens, models: [...o.router.used], finishedEarly };
      } catch (error) {
        if (o.signal.aborted) throw error;
        if (!(error instanceof TurnFailure)) throw error;
        const decision = o.router.decide(error);
        if (decision.action === "fail") {
          o.emit({ type: "model.failed", model: o.router.current, kind: decision.kind, message: decision.reason });
          throw new Error(decision.reason);
        }
        if (decision.action === "retry") {
          o.emit({ type: "model.retry", model: o.router.current, kind: decision.kind, delayMs: decision.delayMs, message: decision.reason });
          await wait(decision.delayMs, o.signal);
        } else {
          o.emit({ type: "model.switch", from: decision.from, to: decision.to, kind: decision.kind, message: decision.reason });
          await o.client.sessions.update(sessionId, { agent: { spec: o.buildSpec(decision.to) } } as any, { maxRetries: 0 });
        }
        // Nothing reached the model yet: resend the request. Otherwise continue from history.
        input = toolActivity === 0 && !previousTurnId ? o.input : (o.continuation ?? "Continue the task from where you stopped.");
      }
    }
  } finally {
    o.signal.removeEventListener("abort", cancel);
  }

  async function streamTurn(): Promise<{ text: string; finishedEarly: boolean }> {
    const stream = await o.client.sessions.createTurnStream(
      sessionId,
      { input: [{ type: "user.message", content: input }], ...(previousTurnId ? { previousTurnId } : {}) } as any,
      { abortSignal: o.signal, timeoutInSeconds: 900, maxRetries: 0 } as any,
    );
    let text = "", turnId: string | undefined, finishing = false, stopRequested = false;
    const systemCalls = new Map<string, number>();
    const seen = new Set<string>();
    for await (const e of stream as AsyncIterable<any>) {
      o.signal.throwIfAborted();
      if (e.type !== "model.message.delta" && e.id) {
        const key = `${e.type}:${e.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      switch (e.type) {
        case "turn.created":
          turnId = e.turnId;
          break;
        case "model.message": {
          if (finishing && turnId) {
            // The review decision is final; skip the model's closing remarks to save quota.
            stopRequested = true;
            await o.client.sessions.cancel(sessionId, {}, { maxRetries: 0 }).catch(() => undefined);
            break;
          }
          // The cap counts *completed* responses (see usage below); failed provider attempts are free.
          if (completed >= maxCalls) {
            stopRequested = true;
            await o.client.sessions.cancel(sessionId, {}, { maxRetries: 0 }).catch(() => undefined);
            throw new Error(`Stopped after ${maxCalls} model calls (forge.maxModelCalls). Staged edits are kept for review.`);
          }
          modelCalls++;
          o.emit({ type: "model.call", n: modelCalls, model: o.router.current });
          break;
        }
        case "model.message.delta": {
          if (e.reasoningContent) o.emit({ type: "reasoning.delta", text: e.reasoningContent });
          if (e.content) { text += e.content; o.emit({ type: "assistant.delta", text: e.content }); }
          if (e.toolCalls?.length) {
            toolActivity++;
            // Surface TrueForge's own harness tools (e.g. list_tools = deferred tool loading).
            for (const tc of e.toolCalls) {
              const name = tc.function?.name;
              if (!tc.id || !name || systemCalls.has(tc.id)) continue;
              if (tc.toolInfo?.type !== "truefoundry-system" && (!o.ownTools || o.ownTools.includes(name))) continue;
              systemCalls.set(tc.id, Date.now());
              o.emit({ type: "tool.start", id: `tf-${tc.id}`, name, title: `TrueForge ${HARNESS_TITLES[name] ?? name}` });
            }
          }
          if (e.usage) {
            completed++;
            inputTokens += e.usage.inputTokens ?? 0;
            outputTokens += e.usage.outputTokens ?? 0;
            o.emit({ type: "usage", inputTokens: e.usage.inputTokens ?? 0, outputTokens: e.usage.outputTokens ?? 0,
              breakdown: e.usage.inputTokensBreakdown, totalInput: inputTokens, totalOutput: outputTokens });
          }
          break;
        }
        case "tool.response": {
          toolActivity++;
          const started = systemCalls.get(e.toolCallId);
          if (started !== undefined) {
            systemCalls.delete(e.toolCallId);
            o.emit({ type: "tool.end", id: `tf-${e.toolCallId}`, ok: true, ms: Date.now() - started, summary: harnessSummary(String(e.content ?? "")), preview: String(e.content ?? "").slice(0, 1500) });
          }
          break;
        }
        case "thread.context_compaction_started":
          o.emit({ type: "compaction", phase: "started" });
          break;
        case "thread.context_compaction_finished":
          o.emit({ type: "compaction", phase: "finished" });
          break;
        case "tool.approval_required": {
          const calls: any[] = e.toolCalls ?? [];
          for (const call of calls) {
            const request = await approvalRequest(call, turnId);
            const decision = o.onApproval ? await o.onApproval(request) : { allow: false, reason: "No reviewer is attached." };
            await o.client.sessions.createTurnEvents(sessionId, turnId!, {
              events: [{ type: "user.tool_approval", threadId: e.threadId, toolCallId: call.id,
                approval: decision.allow ? { status: "allow" } : { status: "deny", reason: decision.reason ?? "Rejected by the reviewer." } }],
            } as any, { maxRetries: 0 });
            if (decision.finish) finishing = true;
          }
          break;
        }
        case "turn.done": {
          previousTurnId = turnId ?? previousTurnId;
          const state = e.state ?? {};
          if (state.metrics) {
            inputTokens = state.metrics.totalInputTokens ?? inputTokens;
            outputTokens = state.metrics.totalOutputTokens ?? outputTokens;
          }
          if (state.status === "done") return { text: textOf(state.output?.content) || text, finishedEarly: false };
          if (state.status === "cancelled" && (stopRequested || finishing)) return { text, finishedEarly: true };
          if (state.status === "cancelled" && o.signal.aborted) throw new DOMException("Cancelled", "AbortError");
          throw new TurnFailure(redact(String(state.message ?? `Turn ended with status ${state.status}`)));
        }
      }
    }
    if (o.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (finishing || stopRequested) return { text, finishedEarly: true };
    throw new TurnFailure("Stream disconnected before the turn finished (network).");
  }

  /** Read the exact arguments TrueForge will execute for an approval-gated call. */
  async function approvalRequest(ref: any, turnId?: string): Promise<ApprovalRequest> {
    let name = ref.function?.name ?? ref.name ?? "unknown", args: Record<string, unknown> = {};
    if (ref.function?.arguments) args = safeJson(ref.function.arguments);
    if (turnId && (!ref.function?.arguments)) {
      for await (const item of await o.client.sessions.listTurnEvents(sessionId, turnId, undefined, { maxRetries: 0 }) as AsyncIterable<any>) {
        if (item.type !== "model.message") continue;
        const call = item.toolCalls?.find((t: any) => t.id === ref.id);
        if (call) { name = call.function.name; args = safeJson(call.function.arguments); }
      }
    }
    return { toolName: name, toolCallId: ref.id, arguments: args };
  }
}

const HARNESS_TITLES: Record<string, string> = { list_tools: "list_tools · deferred tool loading" };

function harnessSummary(content: string) {
  const names = [...content.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
  return names.length ? `${names.length} tools available: ${[...new Set(names)].slice(0, 6).join(", ")}` : content.split("\n", 1)[0].slice(0, 140) || "done";
}

function safeJson(text: string): Record<string, unknown> {
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => typeof part === "string" ? part : part?.type === "text" ? part.text ?? "" : "").join("");
}
