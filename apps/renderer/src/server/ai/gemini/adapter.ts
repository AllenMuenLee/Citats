import "server-only";

import { z } from "zod";

import type { ModelRoleConfig } from "../config";
import {
  assertRequestWithinLimits,
  createStreamingAdapter,
  iterateSseData,
  parseSseJson,
  type HttpCall,
  type StreamingProvider,
} from "../streaming";
import {
  providerError,
  type ConversationTurn,
  type ModelAdapter,
  type ModelAdapterOptions,
  type ModelStreamEvent,
  type ModelStreamRequest,
  type ModelToolDefinition,
  type TextCompletion,
} from "../types";

/**
 * Google Generative Language API adapter.
 *
 * Two details of this API shape the mapping below:
 *
 * - Function calls carry a `name`, not necessarily an id. A tool result is
 *   therefore returned as a `functionResponse` keyed by the function's name
 *   (see `toContents`), and the orchestrator's own call id -- which Gemini
 *   never issued and would reject -- is deliberately not sent back.
 * - Hosted web search is the built-in `google_search` grounding tool. It
 *   reports itself after the fact through `groundingMetadata` rather than as
 *   a tool-execution event, so the status and the cited sources are
 *   synthesised from that metadata.
 */
const PartSchema = z.object({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  functionCall: z.object({
    id: z.string().optional(),
    name: z.string(),
    args: z.unknown().optional(),
  }).optional(),
  inlineData: z.object({
    mimeType: z.string(),
    data: z.string(),
  }).optional(),
});

const GroundingChunkSchema = z.object({
  web: z.object({ uri: z.string().optional(), title: z.string().optional() }).optional(),
});

const ChunkSchema = z.object({
  responseId: z.string().optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  candidates: z.array(z.object({
    content: z.object({ parts: z.array(PartSchema).optional() }).optional(),
    finishReason: z.string().optional(),
    groundingMetadata: z.object({
      groundingChunks: z.array(GroundingChunkSchema).optional(),
      webSearchQueries: z.array(z.string()).optional(),
    }).optional(),
  })).optional(),
  usageMetadata: z.object({
    promptTokenCount: z.number().int().nonnegative().optional(),
    candidatesTokenCount: z.number().int().nonnegative().optional(),
    totalTokenCount: z.number().int().nonnegative().optional(),
  }).optional(),
});

const BLOCKED_FINISH_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"]);

const SAFE_INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Strips any `models/` prefix so the model id can be pasted from either the docs or the console. */
function modelPath(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

function endpoint(config: ModelRoleConfig, method: string, query = ""): URL {
  return new URL(`models/${encodeURIComponent(modelPath(config.model))}:${method}${query}`, config.baseUrl);
}

function authHeaders(config: ModelRoleConfig, correlationId?: string): Record<string, string> {
  return {
    "x-goog-api-key": config.apiKey,
    ...(correlationId ? { "x-goog-request-params": `correlation=${encodeURIComponent(correlationId)}` } : {}),
  };
}

function parseArguments(value: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Maps the orchestrator's flat turn history onto Gemini `contents`. An
 * assistant turn that issued tool calls becomes one `functionCall` part per
 * call, and each `tool` turn becomes a `functionResponse` correlated by
 * name, so the model keeps seeing its own prior calls and their results.
 */
export function toContents(turns: readonly ConversationTurn[]): unknown[] {
  const contents: unknown[] = [];
  for (const turn of turns) {
    if (turn.role === "tool") {
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: turn.name ?? "tool",
            // Wrapped rather than spread: a tool result is untrusted data, and
            // an object-valued `response` keeps it one inert JSON value
            // instead of letting its own keys become response fields.
            response: { result: turn.content },
          },
        }],
      });
      continue;
    }
    const parts: unknown[] = [];
    if (turn.content.length > 0) parts.push({ text: turn.content });
    for (const call of turn.toolCalls ?? []) {
      parts.push({ functionCall: { name: call.name, args: parseArguments(call.arguments) } });
    }
    if (parts.length === 0) continue;
    contents.push({ role: turn.role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}

function toolsPayload(
  tools: readonly ModelToolDefinition[] | undefined,
  hostedTools: readonly string[] | undefined,
): unknown[] | undefined {
  const payload: unknown[] = [];
  if (tools?.length) {
    payload.push({
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // `parametersJsonSchema` takes standard JSON Schema, so the closed
        // schemas the tool registry already owns (additionalProperties:false,
        // patterns, maxLength) are sent verbatim rather than lossily
        // downgraded to the OpenAPI subset `parameters` accepts.
        parametersJsonSchema: tool.parameters,
      })),
    });
  }
  if (hostedTools?.includes("web_search")) payload.push({ googleSearch: {} });
  return payload.length > 0 ? payload : undefined;
}

function generationConfig(request: Pick<ModelStreamRequest, "responseFormat">): Record<string, unknown> | undefined {
  if (!request.responseFormat) return undefined;
  return {
    responseMimeType: "application/json",
    responseJsonSchema: request.responseFormat.schema,
  };
}

const gemini: StreamingProvider = {
  requestIdHeaders: ["x-goog-request-id", "x-request-id"],

  buildRequest(config, request): HttpCall {
    assertRequestWithinLimits(request);
    const tools = toolsPayload(request.tools, request.hostedTools);
    const config_ = generationConfig(request);
    return {
      url: endpoint(config, "streamGenerateContent", "?alt=sse"),
      headers: authHeaders(config, request.correlationId),
      body: {
        systemInstruction: { parts: [{ text: request.systemInstruction }] },
        contents: toContents(request.turns),
        ...(tools ? { tools } : {}),
        ...(config_ ? { generationConfig: config_ } : {}),
      },
    };
  },

  async *parseStream(response): AsyncGenerator<ModelStreamEvent> {
    let toolCallIndex = 0;
    let searchAnnounced = false;
    const seenSources = new Set<string>();
    for await (const data of iterateSseData(response)) {
      const parsed = ChunkSchema.safeParse(parseSseJson(data));
      if (!parsed.success) throw providerError("AI_MALFORMED_RESPONSE", parsed.error);
      const chunk = parsed.data;
      if (chunk.promptFeedback?.blockReason) throw providerError("AI_SAFETY_REFUSAL");
      for (const candidate of chunk.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          // `thought` parts are the model's own reasoning summary, never the answer.
          if (part.text && !part.thought) yield { type: "text-delta", text: part.text };
          if (part.functionCall) {
            yield {
              type: "tool-call-delta",
              index: toolCallIndex,
              id: part.functionCall.id,
              name: part.functionCall.name,
              argumentsDelta: JSON.stringify(part.functionCall.args ?? {}),
            };
            toolCallIndex += 1;
          }
          if (part.inlineData && SAFE_INLINE_IMAGE_TYPES.has(part.inlineData.mimeType)) {
            yield {
              type: "artifact",
              artifactType: "image",
              url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
              title: "Generated image",
              mediaType: part.inlineData.mimeType,
            };
          }
        }
        const grounding = candidate.groundingMetadata;
        if (grounding && !searchAnnounced) {
          searchAnnounced = true;
          yield { type: "hosted-tool-status", id: "google_search", name: "web_search", state: "completed" };
        }
        for (const groundingChunk of grounding?.groundingChunks ?? []) {
          const uri = groundingChunk.web?.uri;
          if (!uri || seenSources.has(uri)) continue;
          const safe = safeHttpUrl(uri);
          if (!safe) continue;
          seenSources.add(uri);
          yield { type: "artifact", artifactType: "source", url: safe, title: groundingChunk.web?.title ?? safe };
        }
        if (candidate.finishReason && BLOCKED_FINISH_REASONS.has(candidate.finishReason)) {
          throw providerError("AI_SAFETY_REFUSAL");
        }
        if (candidate.finishReason) yield { type: "finish", reason: candidate.finishReason.toLowerCase() };
      }
      if (chunk.usageMetadata) {
        yield {
          type: "usage",
          promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          completionTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
        };
      }
    }
  },
};

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function createGeminiAdapter(config: ModelRoleConfig, options: ModelAdapterOptions = {}): ModelAdapter {
  return createStreamingAdapter(gemini, config, options);
}

const CompletionSchema = z.object({
  modelVersion: z.string().optional(),
  candidates: z.array(z.object({
    content: z.object({ parts: z.array(PartSchema).optional() }).optional(),
    finishReason: z.string().optional(),
  })).min(1),
});

/**
 * One non-streaming, schema-constrained completion. Never given a tool of
 * any kind -- the UI-generation agent only reads its canonical input and
 * returns one JSON object.
 */
export function createGeminiCompletion(
  config: ModelRoleConfig,
  fetchImpl: typeof fetch = fetch,
): TextCompletion {
  return async (request, signal) => {
    const response = await fetchImpl(endpoint({ ...config, model: request.model }, "generateContent"), {
      method: "POST",
      signal,
      headers: { ...authHeaders(config), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: request.userContent }] }],
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.maxTokens,
          responseMimeType: "application/json",
          responseJsonSchema: request.responseFormat.schema,
        },
      }),
    });
    if (!response.ok) throw providerError(response.status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_UNAVAILABLE");
    const parsed = CompletionSchema.safeParse(await response.json());
    if (!parsed.success) throw providerError("AI_MALFORMED_RESPONSE", parsed.error);
    const candidate = parsed.data.candidates[0]!;
    if (candidate.finishReason && BLOCKED_FINISH_REASONS.has(candidate.finishReason)) {
      throw providerError("AI_SAFETY_REFUSAL");
    }
    const content = (candidate.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (!content) throw providerError("AI_MALFORMED_RESPONSE");
    return { model: parsed.data.modelVersion ?? request.model, content };
  };
}
