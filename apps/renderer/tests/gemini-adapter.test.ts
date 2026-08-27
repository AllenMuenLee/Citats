import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createGeminiAdapter, createGeminiCompletion, type ModelRoleConfig, type ModelStreamEvent } from "../src/server/ai";

const config: ModelRoleConfig = {
  provider: "gemini",
  apiKey: "test-key",
  model: "gemini-3.5-flash",
  baseUrl: new URL("https://gemini.test/v1beta/"),
  timeoutMs: 1_000,
  maxRetries: 2,
  retryMaxElapsedMs: 60_000,
};

function sse(...chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-goog-request-id": "provider-123" },
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

describe("Gemini adapter", () => {
  it("streams normalized text, usage, finish, and request metadata", async () => {
    const metrics = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { candidates: [{ content: { parts: [{ text: "Hel" }] } }] },
      {
        candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      },
    ));
    const adapter = createGeminiAdapter(config, { fetchImpl, emitMetrics: metrics });

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
    expect(String(url)).toBe("https://gemini.test/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse");
    expect(init?.headers).toEqual(expect.objectContaining({ "x-goog-api-key": "test-key" }));
    expect(bodyOf(fetchImpl)).toEqual(expect.objectContaining({
      systemInstruction: { parts: [{ text: "Trusted policy" }] },
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    }));
  });

  it("skips the model's own reasoning parts and never emits them as answer text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { candidates: [{ content: { parts: [{ text: "internal", thought: true }, { text: "answer" }] } }] },
    ));
    const events = await collect(createGeminiAdapter(config, { fetchImpl }).stream(request));
    expect(events.filter((event) => event.type === "text-delta")).toEqual([{ type: "text-delta", text: "answer" }]);
  });

  it("normalizes a function call into a single tool-call delta carrying serialized arguments", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { candidates: [{ content: { parts: [{ functionCall: { name: "system.echo", args: { message: "hi" } } }] }, finishReason: "STOP" }] },
    ));
    const events = await collect(createGeminiAdapter(config, { fetchImpl }).stream(request));
    expect(events).toContainEqual({
      type: "tool-call-delta", index: 0, id: undefined, name: "system.echo", argumentsDelta: '{"message":"hi"}',
    });
  });

  it("sends closed tool schemas verbatim and maps the hosted web search onto google search", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    await collect(createGeminiAdapter(config, { fetchImpl }).stream({
      ...request,
      tools: [{ name: "system.echo", description: "Echo", strict: true, parameters: { type: "object", additionalProperties: false } }],
      hostedTools: ["web_search"],
    }));
    expect(bodyOf(fetchImpl).tools).toEqual([
      { functionDeclarations: [{ name: "system.echo", description: "Echo", parametersJsonSchema: { type: "object", additionalProperties: false } }] },
      { googleSearch: {} },
    ]);
  });

  it("reports grounded search as a hosted tool status with its cited http(s) sources only", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse({
      candidates: [{
        content: { parts: [{ text: "grounded" }] },
        groundingMetadata: {
          webSearchQueries: ["q"],
          groundingChunks: [
            { web: { uri: "https://example.com/a", title: "A" } },
            { web: { uri: "https://example.com/a", title: "A" } },
            { web: { uri: "javascript:alert(1)", title: "bad" } },
          ],
        },
      }],
    }));
    const events = await collect(createGeminiAdapter(config, { fetchImpl }).stream(request));
    expect(events).toContainEqual({ type: "hosted-tool-status", id: "google_search", name: "web_search", state: "completed" });
    expect(events.filter((event) => event.type === "artifact")).toEqual([
      { type: "artifact", artifactType: "source", url: "https://example.com/a", title: "A" },
    ]);
  });

  it("returns a tool result as a function response correlated by name", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    await collect(createGeminiAdapter(config, { fetchImpl }).stream({
      ...request,
      turns: [
        { role: "user", content: "read it" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "system.echo", arguments: '{"message":"hi"}' }] },
        { role: "tool", content: '{"status":"ok"}', toolCallId: "call-1", name: "system.echo" },
      ],
    }));
    expect(bodyOf(fetchImpl).contents).toEqual([
      { role: "user", parts: [{ text: "read it" }] },
      { role: "model", parts: [{ functionCall: { name: "system.echo", args: { message: "hi" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "system.echo", response: { result: '{"status":"ok"}' } } }] },
    ]);
  });

  it("requests structured output through the JSON schema response format", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }));
    await collect(createGeminiAdapter(config, { fetchImpl }).stream({
      ...request,
      responseFormat: { name: "routing_decision", schema: { type: "object" }, strict: true },
    }));
    expect(bodyOf(fetchImpl).generationConfig).toEqual({
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
    });
  });

  it.each([
    ["a blocked prompt", { promptFeedback: { blockReason: "SAFETY" } }],
    ["a blocked candidate", { candidates: [{ finishReason: "PROHIBITED_CONTENT" }] }],
  ] as const)("maps %s to a safety refusal", async (_label, chunk) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse(chunk));
    await expect(collect(createGeminiAdapter(config, { fetchImpl }).stream(request)))
      .rejects.toMatchObject({ code: "AI_SAFETY_REFUSAL" });
  });

  it.each([
    [401, "AI_AUTHENTICATION_FAILED"],
    [400, "AI_REQUEST_REJECTED"],
    [404, "AI_REQUEST_REJECTED"],
    [422, "AI_REQUEST_REJECTED"],
    [503, "AI_PROVIDER_UNAVAILABLE"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const adapter = createGeminiAdapter({ ...config, maxRetries: 0 }, {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })),
    });
    await expect(collect(adapter.stream(request))).rejects.toMatchObject({ code });
  });

  it("retries a bounded rate limit before streaming", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(sse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const metrics = vi.fn();
    const events = await collect(createGeminiAdapter(config, { fetchImpl, sleep, random: () => 0, emitMetrics: metrics }).stream(request));

    expect(events).toContainEqual({ type: "text-delta", text: "ok" });
    expect(sleep).toHaveBeenCalledWith(100, expect.any(AbortSignal));
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ attemptCount: 2 }));
  });

  it("stops retrying once the total retry budget would be exceeded", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
    const adapter = createGeminiAdapter({ ...config, maxRetries: 5, retryMaxElapsedMs: 1_000 }, {
      fetchImpl, sleep: vi.fn().mockResolvedValue(undefined), random: () => 0,
      // Each attempt burns 900ms of wall clock against a 1,000ms budget, so the
      // budget -- not maxRetries: 5 -- is what ends the loop, after one retry.
      now: (() => { let value = 0; return () => (value += 900); })(),
    });
    await expect(collect(adapter.stream(request))).rejects.toMatchObject({ code: "AI_RATE_LIMITED" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps a timeout and reports its stable error code", async () => {
    const metrics = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const adapter = createGeminiAdapter({ ...config, timeoutMs: 10, maxRetries: 0 }, { fetchImpl, emitMetrics: metrics });

    await expect(collect(adapter.stream(request))).rejects.toMatchObject({ code: "AI_TIMEOUT" });
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AI_TIMEOUT" }));
  });

  it("propagates caller cancellation without remapping or retrying", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const result = collect(createGeminiAdapter(config, { fetchImpl }).stream({ ...request, signal: controller.signal }));
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed stream payloads with a stable safe error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("data: not-json\n\n", { status: 200 }));
    await expect(collect(createGeminiAdapter(config, { fetchImpl }).stream(request))).rejects.toMatchObject({
      code: "AI_MALFORMED_RESPONSE",
      message: "The AI service returned an invalid response.",
    });
  });
});

describe("Gemini non-streaming completion", () => {
  it("sends a tool-free, schema-constrained request and returns the joined answer text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      modelVersion: "gemini-3.5-flash-001",
      candidates: [{ content: { parts: [{ text: "reasoning", thought: true }, { text: '{"ok":' }, { text: "true}" }] }, finishReason: "STOP" }],
    }));
    const complete = createGeminiCompletion(config, fetchImpl);

    await expect(complete({
      model: "gemma-4-31B", temperature: 0, maxTokens: 512,
      systemInstruction: "UI policy", userContent: "canonical input",
      responseFormat: { name: "ui_generation_response", schema: { type: "object" }, strict: true },
    }, new AbortController().signal)).resolves.toEqual({ model: "gemini-3.5-flash-001", content: '{"ok":true}' });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://gemini.test/v1beta/models/gemma-4-31B:generateContent");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
    expect(body.generationConfig).toEqual({
      temperature: 0, maxOutputTokens: 512,
      responseMimeType: "application/json", responseJsonSchema: { type: "object" },
    });
  });
});
