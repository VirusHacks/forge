/**
 * Model routing policy: bounded retries with backoff, then automatic fallback.
 *
 * TrueForge has no built-in model fallback, so Forge decides *when* to retry or switch,
 * and TrueForge still executes every model call. A switch updates the live session's
 * agent spec and continues the same session, so tool results are never lost.
 */
export type FailureKind =
  | "rate_limit" | "quota" | "server" | "network" | "unavailable" | "invalid_credentials"
  | "provider_incompatible" | "context_exceeded" | "malformed_output";

export type RouteDecision =
  | { action: "retry"; delayMs: number; kind: FailureKind; reason: string }
  | { action: "switch"; to: string; from: string; kind: FailureKind; reason: string }
  | { action: "fail"; kind?: FailureKind; reason: string };

function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }

function statusOf(error: unknown): number | undefined {
  const e = error as any;
  const direct = e?.statusCode ?? e?.status ?? e?.response?.status;
  if (Number.isInteger(Number(direct))) return Number(direct);
  const match = /Request failed \((\d{3})\)/.exec(messageOf(error));
  return match ? Number(match[1]) : undefined;
}

/** Seconds/ms the provider asked us to wait, from headers or the error text. */
export function retryAfterMs(error: unknown): number | undefined {
  const e = error as any;
  const headers = e?.headers ?? e?.response?.headers;
  const header = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
  if (header !== undefined && Number.isFinite(Number(header))) return Number(header) * 1000;
  const match = /(?:try again in|retry after|retry in)\s+(?:(\d+)m)?(\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i.exec(messageOf(error));
  if (!match) return undefined;
  const minutes = Number(match[1] ?? 0), value = Number(match[2]);
  return Math.ceil(minutes * 60_000 + (match[3]?.toLowerCase() === "ms" ? value : value * 1000));
}

/** Classify provider failures. Tool, validation and review problems are never provider faults. */
export function classifyFailure(error: unknown): FailureKind | undefined {
  const message = messageOf(error), status = statusOf(error);
  if (/per[- ]day|daily|free-models-per-day|quota exceeded|insufficient[_ ]quota|exceeded your current quota/i.test(message)) return "quota";
  if (status === 429 || /\brate limit|too many requests\b/i.test(message)) return "rate_limit";
  if (status === 401 || status === 403 || /invalid api key|unauthorized|authentication|invalid credentials|permission denied/i.test(message)) return "invalid_credentials";
  if (status === 413 || /context length|context window|maximum context|prompt is too long|request too large|too many tokens/i.test(message)) return "context_exceeded";
  if (/reasoning_content.*unsupported|unsupported.*reasoning_content|does not support tools|tool use is not supported/i.test(message)) return "provider_incompatible";
  if (status === 404 || /model .*(does not exist|not found)|no endpoints found|model_not_found/i.test(message)) return "unavailable";
  if (status !== undefined && status >= 500) return "server";
  if (/high demand|overloaded|service unavailable|bad gateway/i.test(message)) return "server";
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|cannot connect|headers timeout|socket hang up|timed out|timeout|network/i.test(message)) return "network";
  if (/tool call validation failed|not in request\.tools|invalid tool call|malformed|failed to parse tool|incomplete model response/i.test(message)) return "malformed_output";
  return undefined;
}

const SECRET = /\b(?:gsk_[A-Za-z0-9_-]{8,}|sk-or-v1-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|org_[A-Za-z0-9]{8,})\b|Bearer\s+[^\s,;"]+/g;
/** Remove credential-like and account-identifying strings before display or logging. */
export function redact(text: string): string { return text.replace(SECRET, "[redacted]"); }

export function providerOf(model: string) { return model.split("/")[0]; }

/** Primary first, then configured fallbacks that TrueForge actually has, de-duplicated. */
export function orderCandidates(primary: string, fallbacks: string[], available?: string[]): string[] {
  const seen = new Set<string>();
  return [primary, ...fallbacks].map(m => m.trim()).filter(m => {
    if (!m || seen.has(m)) return false;
    if (m !== primary && available && !available.includes(m)) return false;
    seen.add(m);
    return true;
  });
}

export interface RouterOptions {
  /** Retries for 5xx/network errors on one model. */ maxRetriesPerModel?: number;
  /** Waits for short per-minute rate limits on one model (free tiers reset within a minute). */ maxRateLimitWaits?: number;
  maxRetryDelayMs?: number; maxSwitches?: number; baseBackoffMs?: number;
}

export class ModelRouter {
  private index = 0;
  private retries = 0;
  private rateWaits = 0;
  private malformedRetries = 0;
  private switches = 0;
  private readonly blockedProviders = new Set<string>();
  readonly used: string[] = [];
  private readonly opts: Required<RouterOptions>;

  constructor(readonly candidates: string[], options: RouterOptions = {}) {
    if (!candidates.length) throw new Error("Choose a model configured in TrueForge.");
    this.opts = { maxRetriesPerModel: 2, maxRateLimitWaits: 5, maxRetryDelayMs: 65_000, maxSwitches: 2, baseBackoffMs: 2_000, ...options };
    this.used.push(candidates[0]);
  }

  get current() { return this.candidates[this.index]; }
  get switchCount() { return this.switches; }

  decide(error: unknown): RouteDecision {
    const kind = classifyFailure(error);
    const reason = redact(messageOf(error)).slice(0, 300);
    if (!kind) return { action: "fail", reason };
    const waitHint = retryAfterMs(error);
    const canRetry = this.retries < this.opts.maxRetriesPerModel;

    if (kind === "rate_limit" && this.rateWaits < this.opts.maxRateLimitWaits && (waitHint ?? 0) <= this.opts.maxRetryDelayMs) {
      this.rateWaits++;
      // Wait slightly past the provider's reset time; without a hint, back off exponentially.
      return { action: "retry", kind, reason, delayMs: waitHint !== undefined ? Math.max(1_000, waitHint + 750) : Math.min(this.opts.maxRetryDelayMs, 4_000 * this.rateWaits) };
    }
    if ((kind === "server" || kind === "network") && canRetry) {
      this.retries++;
      return { action: "retry", kind, reason, delayMs: Math.min(this.opts.maxRetryDelayMs, waitHint ?? this.backoff()) };
    }
    if (kind === "malformed_output" && this.malformedRetries < 1) {
      this.malformedRetries++;
      return { action: "retry", kind, reason, delayMs: 500 };
    }
    // Bad credentials affect every model of the provider; quotas can be per model (e.g. Gemini),
    // so a quota failure only rules out the model that hit it (it is never retried).
    if (kind === "invalid_credentials") this.blockedProviders.add(providerOf(this.current));
    return this.switchModel(kind, reason);
  }

  private backoff() { return this.opts.baseBackoffMs * 2 ** Math.max(0, this.retries - 1); }

  private switchModel(kind: FailureKind, reason: string): RouteDecision {
    if (this.switches >= this.opts.maxSwitches) return { action: "fail", kind, reason: `${reason} (no fallback left)` };
    const from = this.current;
    for (let next = this.index + 1; next < this.candidates.length; next++) {
      if (this.blockedProviders.has(providerOf(this.candidates[next]))) continue;
      this.index = next;
      this.switches++;
      this.retries = 0;
      this.rateWaits = 0;
      this.malformedRetries = 0;
      this.used.push(this.current);
      return { action: "switch", from, to: this.current, kind, reason };
    }
    return { action: "fail", kind, reason: `${reason} (no other configured model available)` };
  }
}
