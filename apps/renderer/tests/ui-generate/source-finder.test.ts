import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TextCompletion, TextCompletionRequest } from "../../src/server/ai/types";
import {
  buildSourceFindingPrompt,
  createSourceFindingStage,
  MAX_SOURCE_CANDIDATES,
  SOURCE_FINDING_SYSTEM_PROMPT,
} from "../../src/server/ui-generate/source-finding/source-finder";

const publicDns = async () => ["93.184.216.34"];

function result(websites: unknown): string {
  return JSON.stringify({ websites });
}

function stageWith(
  transport: TextCompletion,
  overrides: Partial<Parameters<typeof createSourceFindingStage>[0]> = {},
) {
  return createSourceFindingStage({
    model: "source-model-v1",
    transport,
    resolve: publicDns,
    ...overrides,
  });
}

describe("source finding", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses the exact versioned prompt, dedicated model, Google Search, strict JSON, zero temperature, and no custom tools or history", async () => {
    const requests: TextCompletionRequest[] = [];
    const transport: TextCompletion = async (request) => {
      requests.push(request);
      return {
        model: request.model,
        content: result([{ url: "https://example.com/products", reason: "Product records." }]),
      };
    };
    const sources = await stageWith(transport).find({
      request: "compare quiet keyboards",
      correlationId: "private-correlation",
      signal: new AbortController().signal,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      model: "source-model-v1",
      temperature: 0,
      maxTokens: 1_024,
      systemInstruction: SOURCE_FINDING_SYSTEM_PROMPT,
      userContent: buildSourceFindingPrompt("compare quiet keyboards"),
      hostedTools: ["web_search"],
      responseFormat: expect.objectContaining({ name: "source_finding_response", strict: true }),
    });
    expect(Object.keys(requests[0]!)).not.toContain("tools");
    expect(requests[0]!.hostedTools).toEqual(["web_search"]);
    expect(Object.keys(requests[0]!)).not.toContain("turns");
    expect(sources).toEqual([
      {
        sourceId: "src-1",
        url: "https://example.com/products",
        origin: "https://example.com",
        reason: "Product records.",
      },
    ]);
  });

  it("performs at most one bounded schema repair", async () => {
    const transport = vi.fn<TextCompletion>()
      .mockResolvedValueOnce({ model: "source-model-v1", content: "not json" })
      .mockResolvedValueOnce({
        model: "source-model-v1",
        content: result([{ url: "https://example.com/", reason: "Relevant data." }]),
      });
    await stageWith(transport).find({ request: "request", correlationId: "c", signal: new AbortController().signal });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]![0].userContent).toMatch(/^Find public web pages containing the specific facts and entities needed to answer this request\./);

    const alwaysInvalid = vi.fn<TextCompletion>().mockResolvedValue({ model: "source-model-v1", content: "{}" });
    await expect(stageWith(alwaysInvalid).find({ request: "request", correlationId: "c", signal: new AbortController().signal }))
      .rejects.toMatchObject({ category: "no_sources" });
    expect(alwaysInvalid).toHaveBeenCalledTimes(2);
  });

  it("frames UI requests as subject research and requires constraint-specific deep links", () => {
    const request = "find 6 airbnb listings in seattle that's available from sep 4 to 6, and generate a UI for me to compare them";
    const prompt = buildSourceFindingPrompt(request);

    expect(prompt).toContain("Research only the requested subject matter.");
    expect(prompt).toContain(request);
    expect(prompt).not.toContain("help building generative UI");
    expect(SOURCE_FINDING_SYSTEM_PROMPT).toContain("desired presentation; they are never research subjects");
    expect(SOURCE_FINDING_SYSTEM_PROMPT).toContain("exact check-in/check-out dates");
    expect(SOURCE_FINDING_SYSTEM_PROMPT).toContain("Prefer deep links over homepages");
  });

  it("drops known UI-generation resources even if the source model proposes them", async () => {
    const sources = await stageWith(async () => ({
      model: "source-model-v1",
      content: result([
        { url: "https://v0.dev/", reason: "Generates interfaces." },
        { url: "https://ui.shadcn.com/docs", reason: "Documents UI components." },
        { url: "https://www.airbnb.com/s/Seattle--Washington/homes?checkin=2026-09-04&checkout=2026-09-06", reason: "Filtered Seattle stays for the requested dates." },
      ]),
    })).find({ request: "Seattle stays", correlationId: "c", signal: new AbortController().signal });

    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toContain("airbnb.com/s/Seattle--Washington/homes");
  });

  it("repairs unknown fields and lists beyond the server maximum", async () => {
    const valid = [{ url: "https://example.com/", reason: "Relevant." }];
    for (const invalid of [
      JSON.stringify({ websites: valid, extra: true }),
      result(Array.from({ length: MAX_SOURCE_CANDIDATES + 1 }, (_, index) => ({ url: `https://example.com/${index}`, reason: "Relevant." }))),
    ]) {
      const transport = vi.fn<TextCompletion>()
        .mockResolvedValueOnce({ model: "source-model-v1", content: invalid })
        .mockResolvedValueOnce({ model: "source-model-v1", content: result(valid) });
      await stageWith(transport).find({ request: "request", correlationId: "c", signal: new AbortController().signal });
      expect(transport).toHaveBeenCalledTimes(2);
    }
  });

  it("does not misclassify a transport failure as schema repair", async () => {
    const transport = vi.fn<TextCompletion>().mockRejectedValue(new Error("provider unavailable"));
    await expect(stageWith(transport).find({ request: "request", correlationId: "c", signal: new AbortController().signal }))
      .rejects.toMatchObject({ category: "no_sources" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("enforces cancellation even when DNS ignores the signal", async () => {
    const never = new Promise<never>(() => undefined);
    const controller = new AbortController();
    const pending = stageWith(async () => ({
      model: "source-model-v1",
      content: result([{ url: "https://example.com/", reason: "Relevant." }]),
    }), { resolve: () => never }).find({ request: "request", correlationId: "c", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
  });

  it("logs only safe operational fields", async () => {
    const log = vi.fn();
    await stageWith(async () => ({
      model: "resolved-source-model",
      content: result([{ url: "https://example.com/path", reason: "secret reason" }]),
    }), { log }).find({ request: "secret request", correlationId: "secret correlation", signal: new AbortController().signal });

    expect(log).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(log.mock.calls[0]![0]);
    expect(serialized).not.toContain("secret request");
    expect(serialized).not.toContain("secret reason");
    expect(serialized).not.toContain("secret correlation");
    expect(log.mock.calls[0]![0]).toMatchObject({
      stage: "source_finding",
      model: "resolved-source-model",
      proposed: 1,
      accepted: 1,
      origins: ["https://example.com"],
      urls: ["https://example.com/path"],
    });
  });
});
