import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import requestFixture from "../../../../../packages/contracts/fixtures/ui-generation-request/valid-1.json";
import { UiGenerationRequestSchema, digestUiGenerationRequest, type UiGenerationRequest } from "@ai-browser/contracts";
import { buildCanonicalUiModelInput } from "./canonical-input";
import { createUiGenerationAdapter, UiGenerationAdapterError, type UiTransportRequest } from "./ui-adapter";
import { UI_GENERATION_PROMPT_DIGEST, UI_GENERATION_PROMPT_VERSION, UI_GENERATION_SYSTEM_PROMPT } from "./system-prompt";

function request(): UiGenerationRequest {
  return UiGenerationRequestSchema.parse({ ...requestFixture, promptVersion: UI_GENERATION_PROMPT_VERSION, promptDigest: UI_GENERATION_PROMPT_DIGEST });
}

function response(value: UiGenerationRequest, source = "export default function GeneratedView() { return null; }") {
  return {
    schemaVersion: 1, tsxSource: source,
    manifest: { observationIds: [value.brief.observationId], sourceIds: [], recordIds: [], mediaIds: [], capabilityIds: [], emittedCommandKinds: [], localInteractions: [], accessibilityFeatures: [], responsiveRegions: [], runtimeImports: [], fallback: false },
    modelIdentifier: "ignored", promptDigest: value.promptDigest, inputDigest: digestUiGenerationRequest(value),
    runtimeVersion: value.runtimeApiVersion, toolchainVersion: "compiler-1", fallbackReason: null,
  };
}

describe("dedicated UI generation adapter", () => {
  it("forwards the exact prompt, temperature zero, no tools, and strict structured output", async () => {
    const value = request();
    const calls: UiTransportRequest[] = [];
    const adapter = createUiGenerationAdapter({ model: "ui-model-pinned-2026-08", compilerVersion: "compiler-1", maxTokens: 8_000, deadlineMs: 1_000, runtimeExports: ["Text", "Stack"], transport: async (call) => { calls.push(call); return { model: "ui-model-pinned-2026-08", content: JSON.stringify(response(value)) }; } });
    const generated = await adapter.generate(value);
    expect(generated.modelIdentifier).toBe("ui-model-pinned-2026-08");
    expect(calls[0]).toMatchObject({ temperature: 0, responseFormat: { name: "ui_generation_response", strict: true } });
    expect(calls[0]!.systemInstruction).toBe(UI_GENERATION_SYSTEM_PROMPT);
    expect(JSON.parse(calls[0]!.userContent)).not.toHaveProperty("request.correlation");
  });

  it("canonicalizes identical inputs and keeps runtime capabilities server supplied", () => {
    const value = request();
    const changed = { ...value, correlation: { requestId: "other", userId: "other" } };
    const a = buildCanonicalUiModelInput(value, ["Text", "Stack", "Text"]);
    const b = buildCanonicalUiModelInput(changed, ["Stack", "Text"]);
    expect(a).toEqual(b);
    expect(a.input.runtime.exports).toEqual(["Stack", "Text"]);
    expect(() => buildCanonicalUiModelInput({ ...value, promptDigest: "a".repeat(64) }, [])).toThrow(/server-owned prompt/);
  });

  it("allows only one bounded repair containing normalized codes and safe locations", async () => {
    const value = request();
    const calls: UiTransportRequest[] = [];
    const validate = vi.fn().mockResolvedValueOnce([{ code: "raw value: secret", line: 2, column: 4 }]).mockResolvedValueOnce([]);
    const adapter = createUiGenerationAdapter({ model: "pinned", compilerVersion: "compiler-1", maxTokens: 1_000, deadlineMs: 1_000, runtimeExports: [], validate, transport: async (call) => { calls.push(call); return { model: "pinned", content: JSON.stringify(response(value)) }; } });
    await adapter.generate(value);
    // calls[0] is the structural draft (unvalidated); calls[1] is the first
    // finishing attempt (fails validate); calls[2] is the one bounded repair.
    expect(calls).toHaveLength(3);
    expect(calls[1]!.userContent).toContain("priorDraft");
    expect(calls[2]!.userContent).toContain("RAW_VALUE__SECRET");
    expect(calls[2]!.userContent).not.toContain("privileged");
  });

  it("runs the structural draft with a smaller token budget than the finishing call", async () => {
    const value = request();
    const calls: UiTransportRequest[] = [];
    const adapter = createUiGenerationAdapter({ model: "pinned", compilerVersion: "compiler-1", maxTokens: 10_000, deadlineMs: 1_000, runtimeExports: [], transport: async (call) => { calls.push(call); return { model: "pinned", content: JSON.stringify(response(value)) }; } });
    await adapter.generate(value);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.maxTokens).toBeLessThan(calls[1]!.maxTokens);
    expect(calls[1]!.maxTokens).toBe(10_000);
  });

  it("returns a fallback draft immediately without a finishing call", async () => {
    const value = request();
    const calls: UiTransportRequest[] = [];
    const fallback = { ...response(value, null as unknown as string), tsxSource: null, fallbackReason: "insufficient_evidence" as const, manifest: { ...response(value).manifest, fallback: true } };
    const adapter = createUiGenerationAdapter({ model: "pinned", compilerVersion: "compiler-1", maxTokens: 1_000, deadlineMs: 1_000, runtimeExports: [], transport: async (call) => { calls.push(call); return { model: "pinned", content: JSON.stringify(fallback) }; } });
    const generated = await adapter.generate(value);
    expect(calls).toHaveLength(1);
    expect(generated.fallbackReason).toBe("insufficient_evidence");
  });

  it("enforces timeout and caller cancellation", async () => {
    const value = request();
    const transport = (_call: UiTransportRequest, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const timed = createUiGenerationAdapter({ model: "pinned", compilerVersion: "1", maxTokens: 1, deadlineMs: 5, runtimeExports: [], transport });
    await expect(timed.generate(value)).rejects.toMatchObject({ category: "timeout" } satisfies Partial<UiGenerationAdapterError>);
    const controller = new AbortController();
    const cancelled = createUiGenerationAdapter({ model: "pinned", compilerVersion: "1", maxTokens: 1, deadlineMs: 1_000, runtimeExports: [], transport });
    const pending = cancelled.generate(value, controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ category: "cancelled" } satisfies Partial<UiGenerationAdapterError>);
  });

  it("records stable normalized/source structure separately", () => {
    const value = request();
    const canonical = buildCanonicalUiModelInput(value, []);
    const source = response(value).tsxSource;
    expect(canonical.inputDigest).toBe(digestUiGenerationRequest(value));
    expect(createHash("sha256").update(source).digest("hex")).toHaveLength(64);
  });
});
