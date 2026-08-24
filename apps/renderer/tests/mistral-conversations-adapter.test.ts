import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ConversationEvents, ConversationStreamRequest } from "@mistralai/mistralai/models/components";
import { createMistralConversationsAdapter, type MistralConfig, type MistralStreamEvent } from "../src/server/ai/mistral";

const config: MistralConfig = {
  apiKey: "test-key",
  model: "mistral-medium-latest",
  baseUrl: new URL("https://api.mistral.ai/v1/"),
  timeoutMs: 5_000,
  maxRetries: 2,
};

async function collect(iterable: AsyncIterable<MistralStreamEvent>) {
  const events: MistralStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function clientFor(events: ConversationEvents[]) {
  const startStream = vi.fn(async (_request: ConversationStreamRequest) => ({
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  }));
  return { client: { beta: { conversations: { startStream } } }, startStream };
}

describe("Mistral Conversations adapter", () => {
  it("never enables a hosted tool unless this request explicitly asks for it (P02-R01 step 5)", async () => {
    const { client, startStream } = clientFor([{ event: "conversation.response.done", data: { type: "conversation.response.done", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }] as ConversationEvents[]);
    const adapter = createMistralConversationsAdapter(config, { client });
    await collect(adapter.stream({ correlationId: "request-1", systemInstruction: "Trusted", turns: [{ role: "user", content: "hi" }] }));
    const request = startStream.mock.calls[0]?.[0] as ConversationStreamRequest;
    expect(request.tools).toBeUndefined();
    expect(request.store).toBe(false);
  });

  it("forwards custom function definitions alongside only the hosted tools this request enables", async () => {
    const { client, startStream } = clientFor([{ event: "conversation.response.done", data: { type: "conversation.response.done", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }] as ConversationEvents[]);
    const adapter = createMistralConversationsAdapter(config, { client });
    await collect(adapter.stream({
      correlationId: "request-1",
      systemInstruction: "Trusted",
      turns: [{ role: "user", content: "read this page" }],
      tools: [{ name: "browser.navigate_and_extract", description: "Reads a page.", parameters: { type: "object", properties: { url: { type: "string" } } } }],
      hostedTools: ["web_search"],
    }));
    const request = startStream.mock.calls[0]?.[0] as ConversationStreamRequest;
    expect(request.tools).toEqual([
      { type: "function", function: { name: "browser.navigate_and_extract", description: "Reads a page.", parameters: { type: "object", properties: { url: { type: "string" } } } } },
      { type: "web_search" },
    ]);
  });

  it("carries assistant tool calls and their tool results as function.call/function.result entries, not dropped turns", async () => {
    const { client, startStream } = clientFor([{ event: "conversation.response.done", data: { type: "conversation.response.done", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }] as ConversationEvents[]);
    const adapter = createMistralConversationsAdapter(config, { client });
    await collect(adapter.stream({
      correlationId: "request-1",
      systemInstruction: "Trusted",
      turns: [
        { role: "user", content: "read https://example.com" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "browser.navigate_and_extract", arguments: '{"url":"https://example.com"}' }] },
        { role: "tool", content: '{"status":"success"}', toolCallId: "call-1", name: "browser.navigate_and_extract" },
      ],
    }));
    const request = startStream.mock.calls[0]?.[0] as ConversationStreamRequest;
    expect(request.inputs).toEqual([
      { type: "message.input", role: "user", content: "read https://example.com" },
      { type: "function.call", toolCallId: "call-1", name: "browser.navigate_and_extract", arguments: '{"url":"https://example.com"}' },
      { type: "function.result", toolCallId: "call-1", result: '{"status":"success"}' },
    ]);
  });

  it("maps fragmented function.call.delta events into tool-call-delta events keyed by toolCallId", async () => {
    const { client } = clientFor([
      { event: "function.call.delta", data: { type: "function.call.delta", outputIndex: 0, id: "event-1", name: "browser.navigate_and_extract", toolCallId: "call-1", arguments: '{"url":' } },
      { event: "function.call.delta", data: { type: "function.call.delta", outputIndex: 0, id: "event-2", name: "browser.navigate_and_extract", toolCallId: "call-1", arguments: '"https://example.com"}' } },
    ] as ConversationEvents[]);
    const adapter = createMistralConversationsAdapter(config, { client });
    const events = await collect(adapter.stream({ correlationId: "request-1", systemInstruction: "Trusted", turns: [{ role: "user", content: "read it" }] }));
    expect(events).toEqual([
      { type: "tool-call-delta", index: 0, id: "call-1", name: "browser.navigate_and_extract", argumentsDelta: '{"url":' },
      { type: "tool-call-delta", index: 0, id: "call-1", name: "browser.navigate_and_extract", argumentsDelta: '"https://example.com"}' },
    ]);
  });

  it("requests structured JSON output via completionArgs.responseFormat when asked", async () => {
    const { client, startStream } = clientFor([{ event: "conversation.response.done", data: { type: "conversation.response.done", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }] as ConversationEvents[]);
    const adapter = createMistralConversationsAdapter(config, { client });
    await collect(adapter.stream({
      correlationId: "request-1",
      systemInstruction: "Route this",
      turns: [{ role: "user", content: "classify me" }],
      responseFormat: { name: "routing_decision", schema: { type: "object" }, strict: true },
    }));
    const request = startStream.mock.calls[0]?.[0] as ConversationStreamRequest;
    expect(request.completionArgs).toEqual({
      responseFormat: { type: "json_schema", jsonSchema: { name: "routing_decision", schemaDefinition: { type: "object" }, strict: true } },
    });
    expect(request.tools).toBeUndefined();
  });

  it("allowlists code, image, and search tools and maps their stream", async () => {
    const { client, startStream } = clientFor([
      { event: "tool.execution.started", data: { type: "tool.execution.started", outputIndex: 0, id: "search-1", name: "web_search", arguments: "{}" } },
      { event: "tool.execution.done", data: { type: "tool.execution.done", outputIndex: 0, id: "search-1", name: "web_search" } },
      { event: "message.output.delta", data: { type: "message.output.delta", outputIndex: 1, contentIndex: 0, id: "message-1", role: "assistant", content: { type: "tool_reference", tool: "web_search", title: "Source", url: "https://example.com" } } },
      { event: "message.output.delta", data: { type: "message.output.delta", outputIndex: 1, contentIndex: 1, id: "message-1", role: "assistant", content: "Answer" } },
      { event: "conversation.response.done", data: { type: "conversation.response.done", usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } } },
    ] as ConversationEvents[]);
    const adapter = createMistralConversationsAdapter(config, { client });
    const events = await collect(adapter.stream({ correlationId: "request-1", systemInstruction: "Trusted", turns: [{ role: "user", content: "search" }], hostedTools: ["web_search"] }));
    expect(startStream).toHaveBeenCalledWith(expect.objectContaining({
      model: "mistral-medium-latest",
      store: false,
      tools: [{ type: "web_search" }],
    }), expect.objectContaining({ timeoutMs: 5_000 }));
    expect(events).toContainEqual({ type: "hosted-tool-status", id: "search-1", name: "web_search", state: "running" });
    expect(events).toContainEqual({ type: "artifact", artifactType: "source", title: "Source", url: "https://example.com/" });
    expect(events).toContainEqual({ type: "text-delta", text: "Answer" });
    expect(events).toContainEqual({ type: "usage", promptTokens: 5, completionTokens: 3, totalTokens: 8 });
  });

  it("maps generated image files without exposing the API key", async () => {
    const { client } = clientFor([
      { event: "message.output.delta", data: { type: "message.output.delta", outputIndex: 0, contentIndex: 0, id: "message-1", role: "assistant", content: { type: "tool_file", tool: "image_generation", fileId: "file-1", fileName: "image.png", fileType: "image/png" } } },
    ] as ConversationEvents[]);
    const adapter = createMistralConversationsAdapter(config, { client });
    await expect(collect(adapter.stream({ correlationId: "request-1", systemInstruction: "Trusted", turns: [{ role: "user", content: "draw" }], hostedTools: ["image_generation"] }))).resolves.toContainEqual({
      type: "artifact", artifactType: "image", fileId: "file-1", title: "image.png", mediaType: "image/png",
    });
  });

  it("forwards cancellation to the SDK", async () => {
    const controller = new AbortController();
    const startStream = vi.fn(async (_request, options?: { signal?: AbortSignal }) => {
      controller.abort(new Error("stopped"));
      throw options?.signal?.reason;
    });
    const adapter = createMistralConversationsAdapter(config, { client: { beta: { conversations: { startStream } } } });
    await expect(collect(adapter.stream({ correlationId: "request-1", systemInstruction: "Trusted", turns: [{ role: "user", content: "stop" }], signal: controller.signal }))).rejects.toThrow("stopped");
  });
});
