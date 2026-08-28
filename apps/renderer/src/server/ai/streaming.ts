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
  const match = message?.match(/try again in\s+([0-9]+(?:\.[0-9]+)?)(ms|s|m)/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return Math.ceil(amount * (unit === "ms" ? 1 : unit === "m" ? 60_000 : 1_000));
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
    return {
      status,
      type: typeof record.type === "string" ? record.type : undefined,
      code: typeof record.code === "string" ? record.code : undefined,
      message: typeof record.message === "string" ? record.message.slice(0, MAX_ERROR_MESSAGE_CHARS) : undefined,
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
  if (status === 401 || status === 403) return providerError("AI_AUTHENTICATION_FAILED");
  if (status === 429) return providerError("AI_RATE_LIMITED");
  // The model emitted tool-call arguments the provider could not parse. Alone
  // among the 4xxs this is transient -- the identical request commonly
  // succeeds on the next attempt -- so it is reported as a malformed response
  // and retried rather than blamed on the request.
  if (detail?.code === "tool_use_failed") return providerError("AI_MALFORMED_RESPONSE");
  if (status === 400 || status === 404 || status === 413 || status === 422) return providerError("AI_REQUEST_REJECTED");
  return providerError("AI_PROVIDER_UNAVAILABLE");
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
        if ((now() - startedAt) + delay > config.retryMaxElapsedMs) return false;
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
            // The user-facing message is deliberately generic, so the provider's
            // own reason is only ever recoverable here. Server-side only, and
            // narrowed to the four diagnosable fields by `readProviderErrorDetail`.
            console.error("[ai] provider rejected request", {
              provider: config.provider,
              model: config.model,
              correlationId: request.correlationId,
              ...detail,
            });
            const mapped = mapStatus(response.status, detail);
            if (isRetryable(mapped.code) && await backoff(Math.max(retryDelayMs(response), retryDelayFromMessage(detail.message)))) continue;
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
