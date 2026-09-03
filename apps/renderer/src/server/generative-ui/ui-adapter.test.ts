import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { digestUiGenerationRequest, type UiGenerationRequest } from "@ai-browser/contracts";
import { validUiGenerationRequest } from "../../../tests/helpers/ui-generation";
import { buildCanonicalUiModelInput } from "./canonical-input";
import { createUiGenerationAdapter, UiGenerationAdapterError, type UiTransportRequest } from "./ui-adapter";
import { UI_GENERATION_SYSTEM_PROMPT } from "./system-prompt";

function request(): UiGenerationRequest {
  return validUiGenerationRequest();
}

function response(value: UiGenerationRequest, source = "export default function GeneratedView() { return null; }") {
  return {
    schemaVersion: 1, tsxSource: source,
    manifest: { sourceIds: [], localInteractions: [], accessibilityFeatures: [], responsiveRegions: [], runtimeImports: [], fallback: false },
    modelIdentifier: "ignored", promptDigest: value.promptDigest, inputDigest: digestUiGenerationRequest(value),
    runtimeVersion: value.runtime.apiVersion, toolchainVersion: "compiler-1", fallbackReason: null,
  };
}

describe("dedicated UI generation adapter", () => {
  it("forwards the exact prompt, temperature zero, no tools, and no provider structured-output schema", async () => {
    const value = request();
    const calls: UiTransportRequest[] = [];
    const adapter = createUiGenerationAdapter({ model: "ui-model-pinned-2026-08", compilerVersion: "compiler-1", maxTokens: 8_000, transport: async (call) => { calls.push(call); return { model: "ui-model-pinned-2026-08", content: JSON.stringify(response(value)) }; } });
    const generated = await adapter.generate(value);
    expect(generated.modelIdentifier).toBe("ui-model-pinned-2026-08");
    expect(calls[0]).toMatchObject({ temperature: 0 });
    expect(calls[0]).not.toHaveProperty("responseFormat");
    expect(calls[0]!.systemInstruction).toBe(UI_GENERATION_SYSTEM_PROMPT);
    expect(JSON.parse(calls[0]!.userContent)).not.toHaveProperty("request.correlation");
  });

  it("tolerates a fenced or prose-wrapped JSON reply", async () => {
    const value = request();
    const body = JSON.stringify(response(value));
    const adapter = createUiGenerationAdapter({ model: "m", compilerVersion: "compiler-1", maxTokens: 8_000, transport: async () => ({ model: "m", content: "Here you go:\n\`\`\`json\n" + body + "\n\`\`\`" }) });
    const generated = await adapter.generate(value);
    expect(generated.tsxSource).toBe(response(value).tsxSource);
  });

  it("spends a repair attempt re-asking when a reply does not parse as JSON", async () => {
    const value = request();
    const calls: UiTransportRequest[] = [];
    const replies = ["I could not finish that.", "Sorry, here is a partial answer with no JSON.", JSON.stringify(response(value))];
    const adapter = createUiGenerationAdapter({
      model: "pinned", compilerVersion: "compiler-1", maxTokens: 1_000,
      validate: vi.fn().mockResolvedValue([]),
      transport: async (call) => { calls.push(call); return { model: "pinned", content: replies[calls.length - 1]! }; },
    });
    const generated = await adapter.generate(value);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.userContent).toContain("MALFORMED_REPLY");
    expect(generated.tsxSource).toBe(response(value).tsxSource);
  });

  it("surfaces a persistently unparseable reply as the parse category once the budget is spent", async () => {
    const value = request();
    const adapter = createUiGenerationAdapter({
      model: "pinned", compilerVersion: "compiler-1", maxTokens: 1_000,
      transport: async () => ({ model: "pinned", content: "still not JSON" }),
    });
    await expect(adapter.generate(value)).rejects.toMatchObject({ category: "parse" });
  });

  it("canonicalizes identical inputs and keeps runtime capabilities server supplied", () => {
    const value = request();
    const changed = { ...value, correlation: { requestId: "other", userId: "other" } };
    const a = buildCanonicalUiModelInput(value);
    const b = buildCanonicalUiModelInput(changed);
    expect(a).toEqual(b);
    expect((a.input.request as { runtime: { exports: string[] } }).runtime.exports).toEqual([...value.runtime.exports].sort());
    expect(() => buildCanonicalUiModelInput({ ...value, promptDigest: "a".repeat(64) })).toThrow(/server-owned prompt/);
  });

  it("repairs with normalized codes, safe locations, and server-owned hints", async () => {
    const value = request();
    const calls: UiTransportRequest[] = [];
    const validate = vi.fn().mockResolvedValueOnce([{ code: "raw value: secret", line: 2, column: 4 }]).mockResolvedValueOnce([]);
    const adapter = createUiGenerationAdapter({ model: "pinned", compilerVersion: "compiler-1", maxTokens: 1_000, validate, transport: async (call) => { calls.push(call); return { model: "pinned", content: JSON.stringify(response(value)) }; } });
    await adapter.generate(value);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.userContent).toBe(buildCanonicalUiModelInput(value).serialized);
    expect(calls[1]!.userContent).toContain("RAW_VALUE__SECRET");
    expect(calls[1]!.userContent).not.toContain("raw value: secret");
  });

  it("attaches a fix hint for a known code and allows a second repair", async () => {
    const value = request();
    const calls: UiTransportRequest[] = [];
    const validate = vi.fn()
      .mockResolvedValueOnce([{ code: "INVALID_VIEW_PROPS", line: 3 }])
      .mockResolvedValueOnce([{ code: "TYPE_CHECK_2554", line: 4 }])
      .mockResolvedValueOnce([]);
    const adapter = createUiGenerationAdapter({ model: "pinned", compilerVersion: "compiler-1", maxTokens: 1_000, validate, transport: async (call) => { calls.push(call); return { model: "pinned", content: JSON.stringify(response(value)) }; } });
    await adapter.generate(value);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.userContent).toContain("GeneratedViewProps");
    expect(calls[2]!.userContent).toContain("positional arguments");
  });

  it("fails with the pipeline category after the repair budget is spent", async () => {
    const value = request();
    const validate = vi.fn().mockResolvedValue([{ code: "TYPE_CHECK_2304" }]);
    const adapter = createUiGenerationAdapter({ model: "pinned", compilerVersion: "compiler-1", maxTokens: 1_000, validate, transport: async () => ({ model: "pinned", content: JSON.stringify(response(value)) }) });
    await expect(adapter.generate(value)).rejects.toMatchObject({ category: "pipeline" });
    expect(validate).toHaveBeenCalledTimes(3);
  });

  it("uses the configured token bound for its single generation call", async () => {
    const value = request();
    const calls: UiTransportRequest[] = [];
    const adapter = createUiGenerationAdapter({ model: "pinned", compilerVersion: "compiler-1", maxTokens: 10_000, transport: async (call) => { calls.push(call); return { model: "pinned", content: JSON.stringify(response(value)) }; } });
    await adapter.generate(value);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.maxTokens).toBe(10_000);
  });

  it("returns a fallback draft immediately without a finishing call", async () => {
    const value = request();
    const calls: UiTransportRequest[] = [];
    const fallback = { ...response(value, null as unknown as string), tsxSource: null, fallbackReason: "insufficient_evidence" as const, manifest: { ...response(value).manifest, fallback: true } };
    const adapter = createUiGenerationAdapter({ model: "pinned", compilerVersion: "compiler-1", maxTokens: 1_000, transport: async (call) => { calls.push(call); return { model: "pinned", content: JSON.stringify(fallback) }; } });
    const generated = await adapter.generate(value);
    expect(calls).toHaveLength(1);
    expect(generated.fallbackReason).toBe("insufficient_evidence");
  });

  it("enforces caller cancellation", async () => {
    const value = request();
    const transport = (_call: UiTransportRequest, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const controller = new AbortController();
    const cancelled = createUiGenerationAdapter({ model: "pinned", compilerVersion: "1", maxTokens: 1, transport });
    const pending = cancelled.generate(value, controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ category: "cancelled" } satisfies Partial<UiGenerationAdapterError>);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(cancelled.generate(value, alreadyAborted.signal)).rejects.toMatchObject({ category: "cancelled" } satisfies Partial<UiGenerationAdapterError>);

  });

  it("records stable normalized/source structure separately", () => {
    const value = request();
    const canonical = buildCanonicalUiModelInput(value);
    const source = response(value).tsxSource;
    expect(canonical.inputDigest).toBe(digestUiGenerationRequest(value));
    expect(createHash("sha256").update(source).digest("hex")).toHaveLength(64);
  });
});
