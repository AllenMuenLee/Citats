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
 * Groq adapter, over Groq's OpenAI-compatible `chat/completions` endpoint.
 *
 * Hosted web search is Groq's server-executed `browser_search` tool: the
 * model issues it, Groq runs it, and the stream reports it back through
 * `executed_tools` rather than as a function call the orchestrator would
 * have to service. It is only ever sent when the caller explicitly asks for
 * the `web_search` hosted tool.
 */
const UsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

const ExecutedToolSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  type: z.string().optional(),
  output: z.unknown().optional(),
});

const ChunkSchema = z.object({
  id: z.string().optional(),
  choices: z.array(z.object({
    delta: z.object({
      content: z.union([z.string(), z.null()]).optional(),
      executed_tools: z.array(ExecutedToolSchema).optional(),
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
  x_groq: z.object({ usage: UsageSchema.optional() }).optional(),
});

/** Groq's built-in, server-executed search tool -- the portable `web_search` capability on this provider. */
const BROWSER_SEARCH_TOOL = Object.freeze({ type: "browser_search" as const });

/**
 * Generation parameters sent with every Groq request. `reasoning_effort` is
 * accepted by the gpt-oss family this provider is configured for; a Groq
 * model without a reasoning budget rejects it, so it moves here with the
 * rest rather than being spread across call sites.
 */
const GENERATION_PARAMETERS = Object.freeze({
  temperature: 1,
  max_completion_tokens: 2048,
  top_p: 1,
  reasoning_effort: "medium" as const,
  stop: null,
});

export function toMessages(systemInstruction: string, turns: readonly ConversationTurn[]): unknown[] {
  return [
    { role: "system", content: systemInstruction },
    ...turns.map((turn) => ({
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
  ];
}

function toolsPayload(
  tools: readonly ModelToolDefinition[] | undefined,
  hostedTools: readonly string[] | undefined,
): unknown[] | undefined {
  const payload: unknown[] = (tools ?? []).map((tool) => ({ type: "function", function: tool }));
  if (hostedTools?.includes("web_search")) payload.push(BROWSER_SEARCH_TOOL);
  return payload.length > 0 ? payload : undefined;
}

function responseFormatPayload(request: Pick<ModelStreamRequest, "responseFormat">): Record<string, unknown> | undefined {
  if (!request.responseFormat) return undefined;
  return {
    type: "json_schema",
    json_schema: {
      name: request.responseFormat.name,
      strict: request.responseFormat.strict ?? true,
      schema: request.responseFormat.schema,
    },
  };
}

const groq: StreamingProvider = {
  requestIdHeaders: ["x-request-id", "x-groq-request-id"],

  buildRequest(config, request): HttpCall {
    assertRequestWithinLimits(request);
    const tools = toolsPayload(request.tools, request.hostedTools);
    const responseFormat = responseFormatPayload(request);
    return {
      url: new URL("chat/completions", config.baseUrl),
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "x-request-id": request.correlationId,
      },
      body: {
        model: config.model,
        stream: true,
        stream_options: { include_usage: true },
        ...GENERATION_PARAMETERS,
        messages: toMessages(request.systemInstruction, request.turns),
        ...(tools ? { tools } : {}),
        ...(responseFormat ? { response_format: responseFormat } : {}),
      },
    };
  },

  async *parseStream(response): AsyncGenerator<ModelStreamEvent> {
    const announcedSearches = new Set<number>();
    for await (const data of iterateSseData(response)) {
      const parsed = ChunkSchema.safeParse(parseSseJson(data));
      if (!parsed.success || parsed.data.choices.length > 1) {
        throw providerError("AI_MALFORMED_RESPONSE", parsed.success ? undefined : parsed.error);
      }
      const chunk = parsed.data;
      for (const choice of chunk.choices) {
        if (choice.delta.content) yield { type: "text-delta", text: choice.delta.content };
        for (const executed of choice.delta.executed_tools ?? []) {
          if (executed.type !== "browser_search" && executed.type !== "web_search") continue;
          const index = executed.index ?? 0;
          if (announcedSearches.has(index)) continue;
          announcedSearches.add(index);
          yield {
            type: "hosted-tool-status",
            id: `browser_search-${index}`,
            name: "web_search",
            state: executed.output === undefined ? "running" : "completed",
          };
        }
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
      const usage = chunk.usage ?? chunk.x_groq?.usage;
      if (usage) {
        yield {
          type: "usage",
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        };
      }
    }
  },
};

export function createGroqAdapter(config: ModelRoleConfig, options: ModelAdapterOptions = {}): ModelAdapter {
  return createStreamingAdapter(groq, config, options);
}

const CompletionSchema = z.object({
  model: z.string(),
  choices: z.array(z.object({ message: z.object({ content: z.union([z.string(), z.null()]) }) })).min(1),
});

/** One non-streaming, schema-constrained completion with no tools of any kind. */
export function createGroqCompletion(
  config: ModelRoleConfig,
  fetchImpl: typeof fetch = fetch,
): TextCompletion {
  return async (request, signal) => {
    const response = await fetchImpl(new URL("chat/completions", config.baseUrl), {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        messages: [
          { role: "system", content: request.systemInstruction },
          { role: "user", content: request.userContent },
        ],
        tools: [],
        tool_choice: "none",
        response_format: responseFormatPayload(request),
      }),
    });
    if (!response.ok) throw providerError(response.status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_UNAVAILABLE");
    const parsed = CompletionSchema.safeParse(await response.json());
    if (!parsed.success) throw providerError("AI_MALFORMED_RESPONSE", parsed.error);
    const content = parsed.data.choices[0]!.message.content;
    if (!content) throw providerError("AI_MALFORMED_RESPONSE");
    return { model: parsed.data.model, content };
  };
}
