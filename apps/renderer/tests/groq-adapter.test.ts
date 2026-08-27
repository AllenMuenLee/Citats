import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createGroqAdapter, createGroqCompletion, type ModelRoleConfig, type ModelStreamEvent } from "../src/server/ai";

const config: ModelRoleConfig = {
  provider: "groq",
  apiKey: "test-key",
  model: "test-model",
  baseUrl: new URL("https://groq.test/openai/v1/"),
  timeoutMs: 1_000,
  maxRetries: 2,
  retryMaxElapsedMs: 60_000,
};

function sse(...chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "provider-123" },
  });
}

async function collect(iterable: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const values: ModelStreamEvent[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

const request = {
  correlationId: "correlation-123",
  systemInstruction: "Trusted policy",
  turns: [{ role: "user" as const, content: "Hello" }],
};

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
}

describe("Groq adapter", () => {
  it("streams normalized text, usage, finish, and request metadata", async () => {
    const metrics = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { id: "completion", choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
      { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ));
    const adapter = createGroqAdapter(config, { fetchImpl, emitMetrics: metrics });

    await expect(collect(adapter.stream(request))).resolves.toEqual([
      { type: "request-metadata", providerRequestId: "provider-123" },
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", reason: "stop" },
      { type: "usage", promptTokens: 4, completionTokens: 2, totalTokens: 6 },
    ]);
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: "correlation-123", attemptCount: 1, promptTokens: 4, completionTokens: 2,
    }));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://groq.test/openai/v1/chat/completions");
    expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer test-key" }));
    expect(bodyOf(fetchImpl)).toEqual(expect.objectContaining({
      model: "test-model",
      stream: true,
      messages: [
        { role: "system", content: "Trusted policy" },
        { role: "user", content: "Hello" },
      ],
    }));
  });

  it("normalizes structured tool-call argument fragments", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "system.echo", arguments: '{"mes' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'sage":"hi"}' } }] }, finish_reason: "tool_calls" }] },
    ));

    await expect(collect(createGroqAdapter(config, { fetchImpl }).stream(request))).resolves.toEqual([
      { type: "request-metadata", providerRequestId: "provider-123" },
      { type: "tool-call-delta", index: 0, id: "call-1", name: "system.echo", argumentsDelta: '{"mes' },
      { type: "tool-call-delta", index: 0, id: undefined, name: undefined, argumentsDelta: 'sage":"hi"}' },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("maps the hosted web search onto the server-executed browser_search tool", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse({ choices: [{ delta: { content: "ok" } }] }));
    await collect(createGroqAdapter(config, { fetchImpl }).stream({
      ...request,
      tools: [{ name: "system.echo", description: "Echo", strict: true, parameters: { type: "object", additionalProperties: false } }],
      hostedTools: ["web_search"],
    }));
    expect(bodyOf(fetchImpl).tools).toEqual([
      { type: "function", function: { name: "system.echo", description: "Echo", strict: true, parameters: { type: "object", additionalProperties: false } } },
      { type: "browser_search" },
    ]);
  });

  it("reports each server-executed search once, as running then completed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { choices: [{ delta: { executed_tools: [{ index: 0, type: "browser_search" }] } }] },
      { choices: [{ delta: { executed_tools: [{ index: 0, type: "browser_search" }] } }] },
      { choices: [{ delta: { executed_tools: [{ index: 1, type: "browser_search", output: "results" }] }, finish_reason: "stop" }] },
    ));
    const events = await collect(createGroqAdapter(config, { fetchImpl }).stream(request));
    expect(events.filter((event) => event.type === "hosted-tool-status")).toEqual([
      { type: "hosted-tool-status", id: "browser_search-0", name: "web_search", state: "running" },
      { type: "hosted-tool-status", id: "browser_search-1", name: "web_search", state: "completed" },
    ]);
  });

  it("returns tool results as correlated tool messages", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse({ choices: [{ delta: { content: "ok" } }] }));
    await collect(createGroqAdapter(config, { fetchImpl }).stream({
      ...request,
      turns: [
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "system.echo", arguments: '{"message":"hi"}' }] },
        { role: "tool", content: '{"status":"ok"}', toolCallId: "call-1", name: "system.echo" },
      ],
    }));
    expect(bodyOf(fetchImpl).messages).toEqual([
      { role: "system", content: "Trusted policy" },
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "system.echo", arguments: '{"message":"hi"}' } }] },
      { role: "tool", content: '{"status":"ok"}', tool_call_id: "call-1", name: "system.echo" },
    ]);
  });

  it("requests structured output through the JSON schema response format", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse({ choices: [{ delta: { content: "{}" } }] }));
    await collect(createGroqAdapter(config, { fetchImpl }).stream({
      ...request,
      responseFormat: { name: "routing_decision", schema: { type: "object" }, strict: true },
    }));
    expect(bodyOf(fetchImpl).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "routing_decision", strict: true, schema: { type: "object" } },
    });
  });

  it("maps a content filter finish reason to a safety refusal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse({ choices: [{ delta: {}, finish_reason: "content_filter" }] }));
    await expect(collect(createGroqAdapter(config, { fetchImpl }).stream(request)))
      .rejects.toMatchObject({ code: "AI_SAFETY_REFUSAL" });
  });

  it.each([
    [401, "AI_AUTHENTICATION_FAILED"],
    [403, "AI_AUTHENTICATION_FAILED"],
    [400, "AI_REQUEST_REJECTED"],
    [404, "AI_REQUEST_REJECTED"],
    [422, "AI_REQUEST_REJECTED"],
    [503, "AI_PROVIDER_UNAVAILABLE"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const adapter = createGroqAdapter({ ...config, maxRetries: 0 }, {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })),
    });
    await expect(collect(adapter.stream(request))).rejects.toMatchObject({ code });
  });

  /**
   * Groq reports an unparseable tool call as a 400 alongside genuine
   * request rejections. It is the one 4xx worth another attempt, so it must
   * not be reported as a rejected request the retry loop gives up on.
   */
  it("treats an unparseable tool call as transient and retries it", async () => {
    const toolUseFailed = () => new Response(
      JSON.stringify({ error: { message: "Failed to parse tool call arguments as JSON", type: "invalid_request_error", code: "tool_use_failed" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(toolUseFailed())
      .mockResolvedValueOnce(sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }));
    const metrics = vi.fn();
    const events = await collect(createGroqAdapter(config, { fetchImpl, sleep: vi.fn().mockResolvedValue(undefined), random: () => 0, emitMetrics: metrics }).stream(request));

    expect(events).toContainEqual({ type: "text-delta", text: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ attemptCount: 2 }));
  });

  it("gives up on an unparseable tool call once retries are exhausted", async () => {
    const adapter = createGroqAdapter({ ...config, maxRetries: 0 }, {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(
        JSON.stringify({ error: { message: "Failed to parse tool call arguments as JSON", code: "tool_use_failed" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      )),
    });
    await expect(collect(adapter.stream(request))).rejects.toMatchObject({ code: "AI_MALFORMED_RESPONSE" });
  });

  it("retries a bounded rate limit before streaming", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const metrics = vi.fn();
    const events = await collect(createGroqAdapter(config, { fetchImpl, sleep, random: () => 0, emitMetrics: metrics }).stream(request));

    expect(events).toContainEqual({ type: "text-delta", text: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ attemptCount: 2 }));
  });

  it("propagates caller cancellation without remapping or retrying", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const result = collect(createGroqAdapter(config, { fetchImpl }).stream({ ...request, signal: controller.signal }));
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed stream payloads with a stable safe error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("data: not-json\n\n", { status: 200 }));
    await expect(collect(createGroqAdapter(config, { fetchImpl }).stream(request))).rejects.toMatchObject({
      code: "AI_MALFORMED_RESPONSE",
      message: "The AI service returned an invalid response.",
    });
  });

  it("rejects a request whose bounds exceed what may be sent", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(collect(createGroqAdapter(config, { fetchImpl }).stream({ ...request, systemInstruction: "x".repeat(50_001) })))
      .rejects.toThrow(/System instruction is outside the allowed bounds/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Groq non-streaming completion", () => {
  it("sends a tool-free, schema-constrained request and returns the message content", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "groq-ui-001",
      choices: [{ message: { content: '{"ok":true}' } }],
    }));
    const complete = createGroqCompletion(config, fetchImpl);

    await expect(complete({
      model: "groq-ui", temperature: 0, maxTokens: 512,
      systemInstruction: "UI policy", userContent: "canonical input",
      responseFormat: { name: "ui_generation_response", schema: { type: "object" }, strict: true },
    }, new AbortController().signal)).resolves.toEqual({ model: "groq-ui-001", content: '{"ok":true}' });

    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "groq-ui", temperature: 0, max_tokens: 512, tools: [], tool_choice: "none" });
    expect(body.messages).toEqual([
      { role: "system", content: "UI policy" },
      { role: "user", content: "canonical input" },
    ]);
  });
});
