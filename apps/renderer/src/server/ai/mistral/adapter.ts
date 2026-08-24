import "server-only";

import { z } from "zod";

import type { MistralConfig } from "./config";
import {
  MistralProviderError,
  type MistralAdapter,
  type MistralErrorCode,
  type MistralMetrics,
  type MistralStreamEvent,
  type MistralStreamRequest,
} from "./types";

const UsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

const ChunkSchema = z.object({
  id: z.string().optional(),
  choices: z.array(z.object({
    delta: z.object({
      content: z.union([z.string(), z.null()]).optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(),
        id: z.string().optional(),
        function: z.object({
          name: z.string().optional(),
          arguments: z.string().optional(),
        }).optional(),
      })).optional(),
    }),
    finish_reason: z.union([z.string(), z.null()]).optional(),
  })),
  usage: UsageSchema.optional(),
});

export interface MistralAdapterOptions {
  fetchImpl?: typeof fetch;
  emitMetrics?: (metrics: MistralMetrics) => void;
  random?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const safeMessages: Record<MistralErrorCode, string> = {
  AI_AUTHENTICATION_FAILED: "The AI service credentials were rejected.",
  AI_RATE_LIMITED: "The AI service is temporarily busy. Please try again.",
  AI_TIMEOUT: "The AI response timed out. Please try again.",
  AI_MALFORMED_RESPONSE: "The AI service returned an invalid response.",
  AI_SAFETY_REFUSAL: "The AI service declined this request for safety reasons.",
  AI_PROVIDER_UNAVAILABLE: "The AI service is temporarily unavailable.",
};

function providerError(code: MistralErrorCode, cause?: unknown): MistralProviderError {
  return new MistralProviderError(code, safeMessages[code], cause === undefined ? undefined : { cause });
}

function mapStatus(status: number): MistralProviderError {
  if (status === 401 || status === 403) return providerError("AI_AUTHENTICATION_FAILED");
  if (status === 429) return providerError("AI_RATE_LIMITED");
  if (status === 400 || status === 422) return providerError("AI_SAFETY_REFUSAL");
  return providerError("AI_PROVIDER_UNAVAILABLE");
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function requestBody(config: MistralConfig, request: MistralStreamRequest): Record<string, unknown> {
  if (!request.systemInstruction || request.systemInstruction.length > 50_000) {
    throw new TypeError("System instruction is outside the allowed bounds.");
  }
  if (request.turns.length > 100 || request.turns.some((turn) => turn.content.length > 100_000)) {
    throw new TypeError("Conversation turns are outside the allowed bounds.");
  }
  return {
    model: config.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: request.systemInstruction },
      ...request.turns.map((turn) => ({
        role: turn.role,
        content: turn.content,
        ...(turn.toolCallId ? { tool_call_id: turn.toolCallId } : {}),
        ...(turn.name ? { name: turn.name } : {}),
        ...(turn.toolCalls?.length ? {
          tool_calls: turn.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        } : {}),
      })),
    ],
    ...(request.tools?.length ? {
      tools: request.tools.map((tool) => ({
        type: "function",
        function: tool,
      })),
    } : {}),
  };
}

async function* parseSse(response: Response): AsyncGenerator<MistralStreamEvent> {
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
          let json: unknown;
          try {
            json = JSON.parse(data);
          } catch (error) {
            throw providerError("AI_MALFORMED_RESPONSE", error);
          }
          const parsed = ChunkSchema.safeParse(json);
          if (!parsed.success || parsed.data.choices.length > 1) {
            throw providerError("AI_MALFORMED_RESPONSE", parsed.error);
          }
          const chunk = parsed.data;
          for (const choice of chunk.choices) {
            if (choice.delta.content) yield { type: "text-delta", text: choice.delta.content };
            for (const call of choice.delta.tool_calls ?? []) {
              yield {
                type: "tool-call-delta",
                index: call.index,
                id: call.id,
                name: call.function?.name,
                argumentsDelta: call.function?.arguments ?? "",
              };
            }
            if (choice.finish_reason === "content_filter" || choice.finish_reason === "safety") {
              throw providerError("AI_SAFETY_REFUSAL");
            }
            if (choice.finish_reason) yield { type: "finish", reason: choice.finish_reason };
          }
          if (chunk.usage) {
            yield {
              type: "usage",
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            };
          }
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createMistralAdapter(
  config: MistralConfig,
  options: MistralAdapterOptions = {},
): MistralAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const emitMetrics = options.emitMetrics ?? (() => undefined);
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  return {
    async *stream(request) {
      const startedAt = now();
      let firstTokenAt: number | undefined;
      let usage: Extract<MistralStreamEvent, { type: "usage" }> | undefined;
      let attemptCount = 0;
      let errorCode: MistralErrorCode | undefined;
      const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;
      try {
        while (true) {
          attemptCount += 1;
          let response: Response;
          try {
            response = await fetchImpl(new URL("chat/completions", config.baseUrl), {
              method: "POST",
              headers: {
                authorization: `Bearer ${config.apiKey}`,
                "content-type": "application/json",
                accept: "text/event-stream",
                "x-request-id": request.correlationId,
              },
              body: JSON.stringify(requestBody(config, request)),
              signal,
            });
          } catch (error) {
            if (request.signal?.aborted) throw error;
            const mapped = timeoutSignal.aborted
              ? providerError("AI_TIMEOUT", error)
              : providerError("AI_PROVIDER_UNAVAILABLE", error);
            if (mapped.code === "AI_PROVIDER_UNAVAILABLE" && attemptCount <= config.maxRetries) {
              await sleep(Math.floor((100 * (2 ** (attemptCount - 1))) + random() * 100), signal);
              continue;
            }
            throw mapped;
          }
          if (!response.ok) {
            const mapped = mapStatus(response.status);
            const retryable = mapped.code === "AI_RATE_LIMITED" || mapped.code === "AI_PROVIDER_UNAVAILABLE";
            if (retryable && attemptCount <= config.maxRetries) {
              await sleep(Math.floor((100 * (2 ** (attemptCount - 1))) + random() * 100), signal);
              continue;
            }
            throw mapped;
          }
          const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
          if (requestId) yield { type: "request-metadata", providerRequestId: requestId };
          try {
            for await (const event of parseSse(response)) {
              if (firstTokenAt === undefined && (event.type === "text-delta" || event.type === "tool-call-delta")) {
                firstTokenAt = now();
              }
              if (event.type === "usage") usage = event;
              yield event;
            }
          } catch (error) {
            if (request.signal?.aborted) throw request.signal.reason;
            if (timeoutSignal.aborted) throw providerError("AI_TIMEOUT", error);
            if (error instanceof MistralProviderError) throw error;
            throw providerError("AI_PROVIDER_UNAVAILABLE", error);
          }
          return;
        }
      } catch (error) {
        if (error instanceof MistralProviderError) errorCode = error.code;
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
