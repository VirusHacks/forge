/** Events rendered by the Forge sidebar. One vocabulary for inline edits and agent mode. */
export type UiEvent =
  | { type: "context.pack"; files: ContextFileSummary[]; tokens: number; budget: number; ms: number; graph: boolean; terms: string[]; omitted: number; graphInfo?: GraphSummary }
  | { type: "session"; sessionId: string; url: string; agent: string; model: string }
  | { type: "model.call"; n: number; model: string }
  | { type: "model.retry"; model: string; kind: string; delayMs: number; message: string }
  | { type: "model.switch"; from: string; to: string; kind: string; message: string }
  | { type: "model.failed"; model: string; kind?: string; message: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "assistant.delta"; text: string }
  | { type: "tool.start"; id: string; name: string; title: string; detail?: string }
  | { type: "tool.end"; id: string; ok: boolean; ms: number; summary: string; preview?: string }
  | { type: "compaction"; phase: "started" | "finished" }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalInput: number; totalOutput: number; breakdown?: Record<string, number> }
  | { type: "review.request"; reviewId: string; hunks: ReviewHunkSummary[]; summary?: string; verification?: VerificationSummary }
  | { type: "review.result"; applied: boolean; files: string[]; hunks: number }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string }
  | { type: "metrics"; metrics: RunMetrics }
  | { type: "run.end"; status: RunStatus; message?: string };

export type RunStatus = "complete" | "rejected" | "cancelled" | "error";
export interface ContextFileSummary { path: string; role: string; reasons: string[]; tokens: number; ranges: string[] }
export interface ReviewHunkSummary { index: number; path: string; line: number; added: number; removed: number; preview: string; newFile?: boolean }
export interface VerificationSummary { command: string; exitCode: number; summary: string; stale: boolean }
export interface RunMetrics { modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number; ms: number; models: string[] }
export interface GraphSummary { focus: GraphNodeSummary; related: GraphNodeSummary[]; callers: GraphNodeSummary[]; callees: GraphNodeSummary[]; tests: string[]; verifiedEdges?: number; droppedEdges?: number }
export interface GraphNodeSummary { name: string; kind?: string; file: string; line: number }
