import "server-only";

import { Mistral } from "@mistralai/mistralai";
import type {
  ConversationEvents,
  ConversationStreamRequest,
  InputEntries,
} from "@mistralai/mistralai/models/components";
import type { MistralConfig } from "./config";
import {
  MistralProviderError,
  type MistralAdapter,
  type MistralArtifact,
  type MistralConversationTurn,
  type MistralHostedToolName,
  type MistralHostedToolStatus,
  type MistralMetrics,
  type MistralStreamEvent,
  type MistralStreamRequest,
} from "./types";

export const MISTRAL_HOSTED_TOOLS = Object.freeze([
  { type: "code_interpreter" as const },
  { type: "image_generation" as const },
  { type: "web_search" as const },
]);

const HOSTED_TOOL_BY_NAME: Record<MistralHostedToolName, (typeof MISTRAL_HOSTED_TOOLS)[number]> = {
  code_interpreter: MISTRAL_HOSTED_TOOLS[0],
  image_generation: MISTRAL_HOSTED_TOOLS[1],
  web_search: MISTRAL_HOSTED_TOOLS[2],
};

interface ConversationsClient {
  beta: {
    conversations: {
      startStream(
        request: ConversationStreamRequest,
        options?: { signal?: AbortSignal; timeoutMs?: number },
      ): Promise<AsyncIterable<ConversationEvents>>;
    };
  };
}

/**
 * Maps the orchestrator's flat turn history onto the Conversations API's
 * entry-based `inputs`. This is what P02-R01 restores: a `tool` turn
 * becomes a `function.result` entry (correlated by `toolCallId`) and an
 * assistant turn carrying `toolCalls` becomes one `function.call` entry per
 * call, so the model sees its own prior function calls and their results
 * instead of having them silently dropped.
 */
function toConversationInputs(turns: readonly MistralConversationTurn[]): InputEntries[] {
  const entries: InputEntries[] = [];
  for (const turn of turns) {
    if (turn.role === "tool") {
      if (!turn.toolCallId) continue;
      entries.push({ type: "function.result", toolCallId: turn.toolCallId, result: turn.content });
      continue;
    }
    if (turn.content.length > 0) {
      entries.push({ type: "message.input", role: turn.role, content: turn.content });
    }
    for (const call of turn.toolCalls ?? []) {
      entries.push({ type: "function.call", toolCallId: call.id, name: call.name, arguments: call.arguments });
    }
  }
  return entries;
}

export interface MistralConversationsAdapterOptions {
  client?: ConversationsClient;
  emitMetrics?: (metrics: MistralMetrics) => void;
  now?: () => number;
}

const hostedNames = new Set(MISTRAL_HOSTED_TOOLS.map((tool) => tool.type));

function safeHostedName(name: string): MistralHostedToolStatus["name"] | undefined {
  return hostedNames.has(name as MistralHostedToolStatus["name"])
    ? name as MistralHostedToolStatus["name"]
    : undefined;
}

function safeUrl(value: string, allowImageData = false): string | undefined {
  if (allowImageData && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function artifactFromContent(content: unknown): MistralArtifact | undefined {
  if (!content || typeof content !== "object") return undefined;
  const chunk = content as Record<string, unknown>;
  if (chunk.type === "image_url") {
    const image = chunk.imageUrl;
    const url = typeof image === "string" ? image : image && typeof image === "object" && typeof (image as Record<string, unknown>).url === "string" ? String((image as Record<string, unknown>).url) : undefined;
    const safe = url ? safeUrl(url, true) : undefined;
    if (safe) return { type: "artifact", artifactType: "image", url: safe, title: "Generated image" };
  }
  if (chunk.type === "tool_file" && typeof chunk.fileId === "string") {
    const mediaType = typeof chunk.fileType === "string" ? chunk.fileType : undefined;
    return { type: "artifact", artifactType: mediaType?.startsWith("image/") ? "image" : "file", fileId: chunk.fileId, title: typeof chunk.fileName === "string" ? chunk.fileName : "Generated file", mediaType };
  }
  if (chunk.type === "tool_reference" && typeof chunk.title === "string") {
    return { type: "artifact", artifactType: "source", title: chunk.title, url: typeof chunk.url === "string" ? safeUrl(chunk.url) : undefined };
  }
  return undefined;
}

function mapError(error: unknown): MistralProviderError {
  if (error instanceof MistralProviderError) return error;
  const value = error as { statusCode?: number; name?: string };
  if (value.statusCode === 401 || value.statusCode === 403) return new MistralProviderError("AI_AUTHENTICATION_FAILED", "The AI service credentials were rejected.", { cause: error });
  if (value.statusCode === 429) return new MistralProviderError("AI_RATE_LIMITED", "The AI service is temporarily busy. Please try again.", { cause: error });
  if (value.name === "RequestTimeoutError") return new MistralProviderError("AI_TIMEOUT", "The AI response timed out. Please try again.", { cause: error });
  if (value.name === "RequestAbortedError") throw error;
  return new MistralProviderError("AI_PROVIDER_UNAVAILABLE", "The AI service is temporarily unavailable.", { cause: error });
}

async function* mapConversationEvents(stream: AsyncIterable<ConversationEvents>): AsyncGenerator<MistralStreamEvent> {
  for await (const envelope of stream) {
    const event = envelope.data;
    if (event.type === "message.output.delta") {
      if (typeof event.content === "string") yield { type: "text-delta", text: event.content };
      else if (event.content.type === "text") yield { type: "text-delta", text: event.content.text };
      else {
        const artifact = artifactFromContent(event.content);
        if (artifact) yield artifact;
      }
    } else if (event.type === "tool.execution.started" || event.type === "tool.execution.done") {
      const name = safeHostedName(event.name);
      if (name) yield { type: "hosted-tool-status", id: event.id, name, state: event.type === "tool.execution.started" ? "running" : "completed" };
    } else if (event.type === "function.call.delta") {
      yield { type: "tool-call-delta", index: event.outputIndex, id: event.toolCallId, name: event.name, argumentsDelta: event.arguments };
    } else if (event.type === "conversation.response.done") {
      yield { type: "usage", promptTokens: event.usage.promptTokens, completionTokens: event.usage.completionTokens, totalTokens: event.usage.totalTokens };
      yield { type: "finish", reason: "stop" };
    } else if (event.type === "conversation.response.error") {
      throw new MistralProviderError("AI_PROVIDER_UNAVAILABLE", "The AI service could not complete this request.");
    }
  }
}

export function createMistralConversationsAdapter(config: MistralConfig, options: MistralConversationsAdapterOptions = {}): MistralAdapter {
  const client = options.client ?? new Mistral({
    apiKey: config.apiKey,
    serverURL: config.baseUrl.origin,
    timeoutMs: config.timeoutMs,
    retryConfig: { strategy: "backoff", backoff: { initialInterval: 100, maxInterval: 2_000, exponent: 2, maxElapsedTime: config.timeoutMs }, retryConnectionErrors: true },
  });
  const now = options.now ?? Date.now;
  const emitMetrics = options.emitMetrics ?? (() => undefined);
  return {
    async *stream(request: MistralStreamRequest) {
      const startedAt = now();
      let firstTokenAt: number | undefined;
      let usage: Extract<MistralStreamEvent, { type: "usage" }> | undefined;
      let errorCode: MistralProviderError["code"] | undefined;
      try {
        const functionTools = (request.tools ?? []).map((tool) => ({
          type: "function" as const,
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
        const hostedTools = (request.hostedTools ?? []).map((name) => HOSTED_TOOL_BY_NAME[name]);
        const tools = [...functionTools, ...hostedTools];
        const streamRequest: ConversationStreamRequest = {
          inputs: toConversationInputs(request.turns),
          model: config.model,
          instructions: request.systemInstruction,
          store: false,
          ...(tools.length > 0 ? { tools } : {}),
          ...(request.responseFormat
            ? {
                completionArgs: {
                  responseFormat: {
                    type: "json_schema",
                    jsonSchema: {
                      name: request.responseFormat.name,
                      schemaDefinition: request.responseFormat.schema,
                      strict: request.responseFormat.strict ?? true,
                    },
                  },
                },
              }
            : {}),
        };
        const stream = await client.beta.conversations.startStream(streamRequest, { signal: request.signal, timeoutMs: config.timeoutMs });
        for await (const event of mapConversationEvents(stream)) {
          if (firstTokenAt === undefined && (event.type === "text-delta" || event.type === "artifact")) firstTokenAt = now();
          if (event.type === "usage") usage = event;
          yield event;
        }
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason;
        const mapped = mapError(error);
        errorCode = mapped.code;
        throw mapped;
      } finally {
        emitMetrics({ correlationId: request.correlationId, durationMs: now() - startedAt, timeToFirstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - startedAt, promptTokens: usage?.promptTokens, completionTokens: usage?.completionTokens, totalTokens: usage?.totalTokens, attemptCount: 1, errorCode });
      }
    },
  };
}
