import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createMistralAdapter,
  MistralProviderError,
  readMistralConfig,
  type MistralConfig,
  type MistralStreamEvent,
} from "../src/server/ai/mistral";

const config: MistralConfig = {
  apiKey: "test-key",
  model: "test-model",
  baseUrl: new URL("https://api.mistral.test/v1/"),
  timeoutMs: 1_000,
  maxRetries: 2,
};

function sse(...chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "provider-123" },
  });
}

async function collect(iterable: AsyncIterable<MistralStreamEvent>): Promise<MistralStreamEvent[]> {
  const values: MistralStreamEvent[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

const request = {
  correlationId: "correlation-123",
  systemInstruction: "Trusted policy",
  turns: [{ role: "user" as const, content: "Hello" }],
};

describe("Mistral provider adapter", () => {
  it("streams normalized text, usage, finish, and request metadata", async () => {
    const metrics = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { id: "completion", choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
      { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ));
    const adapter = createMistralAdapter(config, { fetchImpl, emitMetrics: metrics });

    await expect(collect(adapter.stream(request))).resolves.toEqual([
      { type: "request-metadata", providerRequestId: "provider-123" },
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", reason: "stop" },
      { type: "usage", promptTokens: 4, completionTokens: 2, totalTokens: 6 },
    ]);
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: "correlation-123",
      attemptCount: 1,
      promptTokens: 4,
      completionTokens: 2,
      totalTokens: 6,
    }));
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer test-key" }));
    expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
      model: "test-model",
      messages: [
        { role: "system", content: "Trusted policy" },
        { role: "user", content: "Hello" },
      ],
    }));
  });

  it("normalizes structured tool-call argument fragments", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "system_echo", arguments: "{\"mes" } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "sage\":\"hi\"}" } }] }, finish_reason: "tool_calls" }] },
    ));
    const adapter = createMistralAdapter(config, { fetchImpl });

    await expect(collect(adapter.stream(request))).resolves.toEqual([
      { type: "request-metadata", providerRequestId: "provider-123" },
      { type: "tool-call-delta", index: 0, id: "call-1", name: "system_echo", argumentsDelta: "{\"mes" },
      { type: "tool-call-delta", index: 0, id: undefined, name: undefined, argumentsDelta: "sage\":\"hi\"}" },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("retries bounded rate limits before streaming", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const metrics = vi.fn();
    const adapter = createMistralAdapter(config, { fetchImpl, sleep, random: () => 0, emitMetrics: metrics });

    const events = await collect(adapter.stream(request));
    expect(events).toContainEqual({ type: "text-delta", text: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100, expect.any(AbortSignal));
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ attemptCount: 2 }));
  });

  it.each([
    [401, "AI_AUTHENTICATION_FAILED"],
    [403, "AI_AUTHENTICATION_FAILED"],
    [400, "AI_SAFETY_REFUSAL"],
    [503, "AI_PROVIDER_UNAVAILABLE"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const adapter = createMistralAdapter({ ...config, maxRetries: 0 }, {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })),
    });
    await expect(collect(adapter.stream(request))).rejects.toMatchObject({ code });
  });

  it("maps a timeout and reports its stable error code", async () => {
    const metrics = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const adapter = createMistralAdapter({ ...config, timeoutMs: 10, maxRetries: 0 }, { fetchImpl, emitMetrics: metrics });

    await expect(collect(adapter.stream(request))).rejects.toMatchObject({ code: "AI_TIMEOUT" });
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AI_TIMEOUT" }));
  });

  it("propagates caller cancellation without remapping or retrying", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const adapter = createMistralAdapter(config, { fetchImpl });
    const result = collect(adapter.stream({ ...request, signal: controller.signal }));
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed stream payloads with a stable safe error", async () => {
    const response = new Response("data: not-json\n\n", { status: 200 });
    const adapter = createMistralAdapter(config, { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    await expect(collect(adapter.stream(request))).rejects.toEqual(
      expect.objectContaining({
        code: "AI_MALFORMED_RESPONSE",
        message: "The AI service returned an invalid response.",
      }) as MistralProviderError,
    );
  });
});

describe("Mistral configuration", () => {
  it("requires an API key without exposing configuration values", () => {
    expect(() => readMistralConfig({})).toThrow("Mistral configuration is invalid (apiKey).");
  });

  it("validates and normalizes trusted server configuration", () => {
    expect(readMistralConfig({
      MISTRAL_API_KEY: "secret-value",
      MISTRAL_MODEL: "mistral-large-latest",
      MISTRAL_API_BASE_URL: "https://mistral.example/v1/",
      MISTRAL_TIMEOUT_MS: "5000",
      MISTRAL_MAX_RETRIES: "1",
    })).toEqual({
      apiKey: "secret-value",
      model: "mistral-large-latest",
      baseUrl: new URL("https://mistral.example/v1/"),
      timeoutMs: 5000,
      maxRetries: 1,
    });
  });
});
