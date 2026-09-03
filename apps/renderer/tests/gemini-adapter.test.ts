import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createGeminiAdapter, createGeminiCompletion, type ModelRoleConfig, type ModelStreamEvent } from "../src/server/ai";
const TEST_RESPONSE_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } } } as const;
const TEST_RESPONSE_FORMAT = { name: "test_response", strict: true, schema: TEST_RESPONSE_SCHEMA } as const;

const config: ModelRoleConfig = {
  provider: "gemini",
  apiKey: "test-key",
  model: "gemini-3.5-flash",
  baseUrl: new URL("https://gemini.test/v1beta/"),
  maxRetries: 2,
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
  it("reports an empty MALFORMED_FUNCTION_CALL candidate as a malformed response instead of an empty turn", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] },
    ));
    const adapter = createGeminiAdapter(config, { fetchImpl });

    await expect(collect(adapter.stream(request))).rejects.toMatchObject({ code: "AI_MALFORMED_RESPONSE" });
  });

  it("keeps a MALFORMED_FUNCTION_CALL turn that did produce text, since the content is usable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { candidates: [{ content: { parts: [{ text: "Partial answer" }] } }] },
      { candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] },
    ));
    const adapter = createGeminiAdapter(config, { fetchImpl });

    await expect(collect(adapter.stream(request))).resolves.toEqual([
      { type: "request-metadata", providerRequestId: "provider-123" },
      { type: "text-delta", text: "Partial answer" },
      { type: "finish", reason: "malformed_function_call" },
    ]);
  });

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

  /**
   * P02-R05: the UI planner's own canonical schema, not a stand-in,
   * has to reach Gemini's native structured-output fields -- and the
   * planning request must advertise no tool, hosted or local.
   */
  it("forwards the canonical UI-plan schema with no tool advertised", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }));
    await collect(createGeminiAdapter(config, { fetchImpl }).stream({ ...request, responseFormat: TEST_RESPONSE_FORMAT }));
    const body = bodyOf(fetchImpl);
    expect(body.generationConfig).toEqual({
      responseMimeType: "application/json",
      responseJsonSchema: TEST_RESPONSE_SCHEMA,
    });
    expect(body.tools).toBeUndefined();
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
  it("enables Google Search for a hosted-search completion", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      modelVersion: "gemini-3.5-flash-lite",
      candidates: [{ content: { parts: [{ text: '{"websites":[]}' }] }, finishReason: "STOP" }],
    }));
    const complete = createGeminiCompletion(config, fetchImpl);

    await complete({
      model: "gemini-3.5-flash-lite", temperature: 0, maxTokens: 1024,
      systemInstruction: "Find sources", userContent: "Seattle stays",
      hostedTools: ["web_search"],
      responseFormat: { name: "sources", schema: { type: "object" }, strict: true },
    }, new AbortController().signal);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.tools).toEqual([{ googleSearch: {} }]);
  });

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

  it("omits provider structured-output arguments for a prompt-only completion", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      modelVersion: "gemini-3.1-flash-lite",
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }],
    }));
    const complete = createGeminiCompletion(config, fetchImpl);

    await complete({
      model: "gemini-3.1-flash-lite", temperature: 0, maxTokens: 16_000,
      systemInstruction: "Define the JSON output here.", userContent: "canonical input",
    }, new AbortController().signal);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as {
      generationConfig: Record<string, unknown>;
    };
    expect(body.generationConfig).toEqual({ temperature: 0, maxOutputTokens: 16_000 });
  });

  it("rejects a reply cut off at the token ceiling instead of returning truncated text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      modelVersion: "gemini-3.5-flash-lite",
      candidates: [{ content: { parts: [{ text: '{"tsxSource":"export default function GeneratedView(' }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 24000, totalTokenCount: 28000 },
    }));
    const complete = createGeminiCompletion(config, fetchImpl);

    await expect(complete({
      model: "gemini-3.5-flash-lite", temperature: 0, maxTokens: 24_000,
      systemInstruction: "UI policy", userContent: "canonical input",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "AI_MALFORMED_RESPONSE" });
  });

  it("retries a transient 503 before returning the completion", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: "high demand" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        modelVersion: "gemini-3.1-flash-lite",
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }],
      }));
    const complete = createGeminiCompletion({ ...config, maxRetries: 2 }, fetchImpl);

    await expect(complete({
      model: "gemini-3.1-flash-lite", temperature: 0, maxTokens: 512,
      systemInstruction: "UI policy", userContent: "canonical input",
    }, new AbortController().signal)).resolves.toEqual({ model: "gemini-3.1-flash-lite", content: '{"ok":true}' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up on a 503 once the retry budget is spent, mapping it to unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: "high demand" } }, { status: 503 }));
    const complete = createGeminiCompletion({ ...config, maxRetries: 0 }, fetchImpl);

    await expect(complete({
      model: "gemini-3.1-flash-lite", temperature: 0, maxTokens: 512,
      systemInstruction: "UI policy", userContent: "canonical input",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 400 rejected request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: "bad field" } }, { status: 400 }));
    const complete = createGeminiCompletion({ ...config, maxRetries: 3 }, fetchImpl);

    await expect(complete({
      model: "gemini-3.1-flash-lite", temperature: 0, maxTokens: 512,
      systemInstruction: "UI policy", userContent: "canonical input",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "AI_REQUEST_REJECTED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
