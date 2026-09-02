import "server-only";

import type { ModelRoleConfig } from "./config";
import {
  ModelProviderError,
  providerError,
  type ModelAdapter,
  type ModelAdapterOptions,
  type ModelErrorCode,
  type ModelStreamEvent,
  type ModelStreamRequest,
} from "./types";

/** Bounds one request may not exceed before it is ever sent, shared by every provider. */
export const REQUEST_LIMITS = Object.freeze({
  maxSystemInstructionChars: 50_000,
  maxTurns: 100,
  maxTurnChars: 100_000,
});

export function assertRequestWithinLimits(request: ModelStreamRequest): void {
  if (!request.systemInstruction || request.systemInstruction.length > REQUEST_LIMITS.maxSystemInstructionChars) {
    throw new TypeError("System instruction is outside the allowed bounds.");
  }
  if (
    request.turns.length > REQUEST_LIMITS.maxTurns
    || request.turns.some((turn) => turn.content.length > REQUEST_LIMITS.maxTurnChars)
  ) {
    throw new TypeError("Conversation turns are outside the allowed bounds.");
  }
}

export function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export function retryDelayMs(response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  for (const name of ["x-ratelimit-reset-tokens", "x-ratelimit-reset-requests"]) {
    const value = response.headers.get(name);
    const match = value?.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m)?$/i);
    if (!match) continue;
    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    return Math.ceil(amount * (unit === "ms" ? 1 : unit === "m" ? 60_000 : 1_000));
  }
  return 0;
}

export function retryDelayFromMessage(message: string | undefined): number {
  // Groq phrases this as "try again in 3.2s" and Gemini as "Please retry in
  // 3.2s". Matching only the former silently collapsed every Gemini 429 to
  // the 100ms floor below, which spent two more requests against the very
  // quota that had just been exhausted.
  const match = message?.match(/(?:try again|retry) in\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m)/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return Math.ceil(amount * (unit === "ms" ? 1 : unit === "m" ? 60_000 : 1_000));
}

export function rateLimitResetLogFields(retryAfterMs: number, nowMs = Date.now()): {
  retryAfterSeconds: number | null;
  retryAt: string | null;
  resetHint: "provider-supplied" | "not-provided";
} {
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return { retryAfterSeconds: null, retryAt: null, resetHint: "not-provided" };
  }
  return {
    retryAfterSeconds: Math.ceil(retryAfterMs / 1_000),
    retryAt: new Date(nowMs + retryAfterMs).toISOString(),
    resetHint: "provider-supplied",
  };
}

/** Bound on the error body read for diagnosis -- enough for one message, never a whole payload. */
const MAX_ERROR_BODY_CHARS = 2_000;
const MAX_ERROR_MESSAGE_CHARS = 500;

/** The diagnosable fields of a provider error body, safe to log. */
export interface ProviderErrorDetail {
  status: number;
  type?: string;
  code?: string;
  message?: string;
  /** The provider's own requested wait, when it stated one in the body rather than a header. */
  retryAfterMs?: number;
}

/**
 * Reads a `google.rpc.RetryInfo` out of a Gemini error body. Gemini sends no
 * `Retry-After` and no `x-ratelimit-*` header on a 429 -- the only machine-
 * readable delay it gives is this one, nested in `error.details`. It is
 * parsed to a number here so the one field that escapes `details` cannot
 * carry provider text into the log.
 */
function readRetryInfoMs(error: Record<string, unknown>): number | undefined {
  const details: unknown = error.details;
  if (!Array.isArray(details)) return undefined;
  for (const entry of details) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record["@type"] !== "string" || !record["@type"].endsWith("google.rpc.RetryInfo")) continue;
    // A protobuf Duration on the wire is always seconds with an `s` suffix.
    const match = typeof record.retryDelay === "string" ? record.retryDelay.match(/^([0-9]+(?:\.[0-9]+)?)s$/) : null;
    if (match) return Math.ceil(Number(match[1]) * 1_000);
  }
  return undefined;
}

/**
 * Extracts the diagnosable fields from a provider error body -- both
 * providers nest them under `error`. Every other field is dropped on
 * purpose: Groq returns the model's own rejected output in
 * `failed_generation`, which may quote untrusted page content, and this
 * value reaches the server log.
 */
export function readProviderErrorDetail(status: number, body: string): ProviderErrorDetail {
  try {
    const parsed: unknown = JSON.parse(body);
    const error: unknown = (parsed as { error?: unknown } | null)?.error;
    if (!error || typeof error !== "object") return { status };
    const record = error as Record<string, unknown>;
    const retryAfterMs = readRetryInfoMs(record);
    return {
      status,
      type: typeof record.type === "string" ? record.type : undefined,
      code: typeof record.code === "string"
        ? record.code
        : typeof record.status === "string" ? record.status : undefined,
      message: typeof record.message === "string" ? record.message.slice(0, MAX_ERROR_MESSAGE_CHARS) : undefined,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  } catch {
    return { status };
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return "";
  }
}

/**
 * Shared HTTP status mapping. Providers only override it where their
 * semantics genuinely differ.
 *
 * A 4xx is never a content refusal on either provider: Groq reports
 * filtering as `finish_reason: content_filter` and Gemini as
 * `promptFeedback.blockReason`, both mid-stream and both already mapped
 * where they occur. Reporting a rejected request as a safety refusal
 * therefore only ever mislabelled a bug in the request this app built --
 * an invalid tool schema reads as "the model declined", which is both
 * wrong and unactionable -- so a rejection is now reported as exactly that.
 */
export function mapHttpStatus(status: number, detail?: ProviderErrorDetail): ModelProviderError {
  // The provider's own sentence, verbatim. A rejected request is nearly
  // always a fact only the provider knows -- which model, which field, which
  // capability -- and paraphrasing it here left the caller with a generic
  // line it could not act on.
  const reason = detail?.message;
  if (status === 401 || status === 403) return providerError("AI_AUTHENTICATION_FAILED", undefined, reason);
  if (status === 429) return providerError("AI_RATE_LIMITED", undefined, reason);
  // The model emitted tool-call arguments the provider could not parse. Alone
  // among the 4xxs this is transient -- the identical request commonly
  // succeeds on the next attempt -- so it is reported as a malformed response
  // and retried rather than blamed on the request.
  if (detail?.code === "tool_use_failed") return providerError("AI_MALFORMED_RESPONSE", undefined, reason);
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return providerError("AI_REQUEST_REJECTED", undefined, reason);
  }
  return providerError("AI_PROVIDER_UNAVAILABLE", undefined, reason);
}

/**
 * Yields the `data:` payload of each SSE frame. Both providers stream
 * `text/event-stream` (Gemini via `?alt=sse`, Groq via its OpenAI-compatible
 * endpoint), so the framing is parsed once here and only the JSON inside it
 * is provider-specific.
 */
export async function* iterateSseData(response: Response): AsyncGenerator<string> {
  if (!response.body) throw providerError("AI_MALFORMED_RESPONSE");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += value ?? "";
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          yield data;
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseSseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch (error) {
    throw providerError("AI_MALFORMED_RESPONSE", error);
  }
}

export interface HttpCall {
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export interface StreamingProvider {
  /** Builds the provider's wire request for one abstract stream request. */
  buildRequest(config: ModelRoleConfig, request: ModelStreamRequest): HttpCall;
  /** Translates the provider's stream into provider-agnostic events. */
  parseStream(response: Response, request: ModelStreamRequest): AsyncGenerator<ModelStreamEvent>;
  /** Response headers that may carry the provider's own request id, most preferred first. */
  requestIdHeaders?: readonly string[];
  mapStatus?(status: number, detail?: ProviderErrorDetail): ModelProviderError;
}

/**
 * Wraps a provider's request-building and stream-parsing in the retry,
 * timeout, cancellation, and metrics behaviour every role depends on: a
 * single attempt is bounded by `timeoutMs`, retryable failures (429 and
 * 5xx/transport) back off exponentially up to `maxRetries` attempts and
 * `retryMaxElapsedMs` of total wall clock, and the caller's own
 * `AbortSignal` (the user's Stop control) always wins over both.
 */
export function createStreamingAdapter(
  provider: StreamingProvider,
  config: ModelRoleConfig,
  options: ModelAdapterOptions = {},
): ModelAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const emitMetrics = options.emitMetrics ?? (() => undefined);
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const mapStatus = provider.mapStatus ?? mapHttpStatus;

  return {
    provider: config.provider,
    async *stream(request) {
      const startedAt = now();
      let firstTokenAt: number | undefined;
      let usage: Extract<ModelStreamEvent, { type: "usage" }> | undefined;
      let attemptCount = 0;
      let errorCode: ModelErrorCode | undefined;
      const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;
      const isRetryable = (code: ModelErrorCode): boolean =>
        code === "AI_RATE_LIMITED"
        || code === "AI_PROVIDER_UNAVAILABLE"
        // Only reachable from the pre-stream status mapping (`tool_use_failed`);
        // a malformed frame mid-stream is rethrown without another attempt.
        || code === "AI_MALFORMED_RESPONSE";
      const backoff = async (minimumDelayMs = 0): Promise<boolean> => {
        if (attemptCount > config.maxRetries) return false;
        const delay = Math.max(minimumDelayMs, Math.floor((100 * (2 ** (attemptCount - 1))) + random() * 100));
        // `timeoutSignal` spans the whole call, sleeps included, so a wait
        // that would outlive it must be declined here rather than entered:
        // sleeping into that abort would surface the provider's own
        // "retry in 47s" as a raw timeout instead of AI_RATE_LIMITED.
        if ((now() - startedAt) + delay > Math.min(config.retryMaxElapsedMs, config.timeoutMs)) return false;
        await sleep(delay, signal);
        return true;
      };
      try {
        while (true) {
          attemptCount += 1;
          const call = provider.buildRequest(config, request);
          let response: Response;
          try {
            response = await fetchImpl(call.url, {
              method: "POST",
              headers: { ...call.headers, "content-type": "application/json", accept: "text/event-stream" },
              body: JSON.stringify(call.body),
              signal,
            });
          } catch (error) {
            if (request.signal?.aborted) throw error;
            const mapped = timeoutSignal.aborted
              ? providerError("AI_TIMEOUT", error)
              : providerError("AI_PROVIDER_UNAVAILABLE", error);
            if (isRetryable(mapped.code) && await backoff()) continue;
            throw mapped;
          }
          if (!response.ok) {
            const detail = readProviderErrorDetail(response.status, await readErrorBody(response));
            const retryAfterMs = Math.max(
              retryDelayMs(response),
              retryDelayFromMessage(detail.message),
              detail.retryAfterMs ?? 0,
            );
            // The provider's reason now also reaches the caller, but only as
            // the one `message` field; the status, attempt and correlation id
            // that make it diagnosable stay server-side.
            console.error("[ai] provider rejected request", {
              provider: config.provider,
              model: config.model,
              correlationId: request.correlationId,
              attempt: attemptCount,
              ...detail,
              // `Date.now()`, not the injected `now`: that clock is the retry
              // budget's, and spending a tick of it on a log timestamp makes
              // every logged 429 shorten the budget it is reporting on.
              ...(response.status === 429 ? rateLimitResetLogFields(retryAfterMs, Date.now()) : {}),
            });
            const mapped = mapStatus(response.status, detail);
            if (isRetryable(mapped.code) && await backoff(retryAfterMs)) continue;
            throw mapped;
          }
          for (const header of provider.requestIdHeaders ?? []) {
            const value = response.headers.get(header);
            if (value) {
              yield { type: "request-metadata", providerRequestId: value };
              break;
            }
          }
          try {
            for await (const event of provider.parseStream(response, request)) {
              if (firstTokenAt === undefined
                && (event.type === "text-delta" || event.type === "tool-call-delta" || event.type === "artifact")) {
                firstTokenAt = now();
              }
              if (event.type === "usage") usage = event;
              yield event;
            }
          } catch (error) {
            if (request.signal?.aborted) throw request.signal.reason;
            if (timeoutSignal.aborted) throw providerError("AI_TIMEOUT", error);
            if (error instanceof ModelProviderError) {
              const causeMessage = error.cause instanceof Error ? error.cause.message : undefined;
              if (firstTokenAt === undefined && error.code !== "AI_MALFORMED_RESPONSE" && isRetryable(error.code) && await backoff(retryDelayFromMessage(causeMessage))) continue;
              throw error;
            }
            throw providerError("AI_PROVIDER_UNAVAILABLE", error);
          }
          return;
        }
      } catch (error) {
        if (error instanceof ModelProviderError) errorCode = error.code;
        throw error;
      } finally {
        emitMetrics({
          correlationId: request.correlationId,
          durationMs: now() - startedAt,
          timeToFirstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - startedAt,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          totalTokens: usage?.totalTokens,
          attemptCount,
          errorCode,
        });
      }
    },
  };
}
