import { describe, expect, it } from "vitest";
import requestFixture from "../fixtures/ui-generation-request/valid-1.json";
import {
  UiGenerationRequestSchema,
  UiGenerationResponseSchema,
  CompiledGeneratedUiArtifactSchema,
  canonicalizeUiGenerationRequest,
  computeGeneratedUiArtifactId,
  digestImplementationPrompt,
  digestUiGenerationRequest,
  validateUiGenerationResponseForRequest,
} from "../src/index.js";

describe("generated UI contracts", () => {
  const request = UiGenerationRequestSchema.parse(requestFixture);

  it("produces stable canonical input while excluding correlation metadata", () => {
    const changedCorrelation = { ...request, correlation: { requestId: "req-2", userId: "user-2" } };
    expect(canonicalizeUiGenerationRequest(changedCorrelation)).toBe(canonicalizeUiGenerationRequest(request));
    expect(digestUiGenerationRequest(changedCorrelation)).toBe(digestUiGenerationRequest(request));
  });

  it("sorts semantically unordered tokens but not the implementation prompt", () => {
    const reversedTokens = { ...request, theme: { ...request.theme, allowedTokens: [...request.theme.allowedTokens].reverse() } };
    expect(digestUiGenerationRequest(reversedTokens)).toBe(digestUiGenerationRequest(request));

    const changedPrompt = `${request.implementationPrompt} Then add a footnote.`;
    const changed = { ...request, implementationPrompt: changedPrompt, implementationPromptDigest: digestImplementationPrompt(changedPrompt) };
    expect(digestUiGenerationRequest(request)).not.toBe(digestUiGenerationRequest(changed));
  });

  it("rejects a request whose implementation-prompt digest does not match", () => {
    expect(UiGenerationRequestSchema.safeParse({ ...request, implementationPromptDigest: "0".repeat(64) }).success).toBe(false);
  });

  it("rejects fallback/source disagreement but treats manifest source ids as advisory", () => {
    const base = {
      schemaVersion: 1,
      tsxSource: null,
      manifest: { sourceIds: ["src-9"], localInteractions: [], accessibilityFeatures: [], responsiveRegions: [], runtimeImports: [], fallback: true },
      modelIdentifier: "model",
      promptDigest: request.promptDigest,
      inputDigest: digestUiGenerationRequest(request),
      runtimeVersion: "1",
      toolchainVersion: "1",
      fallbackReason: "insufficient_evidence",
    };
    // A fallback response that still carries a source is a structural error.
    expect(UiGenerationResponseSchema.safeParse({ ...base, tsxSource: "x" }).success).toBe(false);
    // An unknown manifest source id is logged, not fatal -- the compiler is the real gate.
    expect(() => validateUiGenerationResponseForRequest(request, base)).not.toThrow();
  });

  it("still rejects a response whose identity digest does not pin the request", () => {
    const base = {
      schemaVersion: 1,
      tsxSource: null,
      manifest: { sourceIds: [], localInteractions: [], accessibilityFeatures: [], responsiveRegions: [], runtimeImports: [], fallback: true },
      modelIdentifier: "model",
      promptDigest: request.promptDigest,
      inputDigest: "0".repeat(64),
      runtimeVersion: "1",
      toolchainVersion: "1",
      fallbackReason: "insufficient_evidence",
    };
    expect(() => validateUiGenerationResponseForRequest(request, base)).toThrow(/input digest/);
  });

  it("rejects source over the UTF-8 byte bound", () => {
    const response = {
      schemaVersion: 1,
      tsxSource: "é".repeat(40_000),
      manifest: { sourceIds: [], localInteractions: [], accessibilityFeatures: [], responsiveRegions: [], runtimeImports: [], fallback: false },
      modelIdentifier: "model",
      promptDigest: "a".repeat(64),
      inputDigest: "b".repeat(64),
      runtimeVersion: "1",
      toolchainVersion: "1",
      fallbackReason: null,
    };
    expect(UiGenerationResponseSchema.safeParse(response).success).toBe(false);
  });

  it("binds compiled artifact identity to validated bytes and every identity digest", () => {
    const bytes = Buffer.from("compiled module");
    const identity = {
      bytes,
      implementationPromptDigest: "e".repeat(64),
      inputDigest: "a".repeat(64),
      promptDigest: "b".repeat(64),
      modelDigest: "c".repeat(64),
      toolchainDigest: "d".repeat(64),
    };
    const artifact = {
      schemaVersion: 1,
      artifactId: computeGeneratedUiArtifactId(identity),
      module: { kind: "bytes", encoding: "base64", value: bytes.toString("base64") },
      manifest: { sourceIds: [], localInteractions: [], accessibilityFeatures: [], responsiveRegions: [], runtimeImports: [], fallback: false },
      validation: { valid: true, issues: [] },
      sourceMapPolicy: "omitted",
      implementationPromptDigest: identity.implementationPromptDigest,
      inputDigest: identity.inputDigest,
      promptDigest: identity.promptDigest,
      modelDigest: identity.modelDigest,
      toolchainDigest: identity.toolchainDigest,
      expiresAt: "2030-01-01T00:00:00Z",
      fallbackText: "Generated view unavailable.",
    };
    expect(CompiledGeneratedUiArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(CompiledGeneratedUiArtifactSchema.safeParse({ ...artifact, artifactId: `gui_${"f".repeat(64)}` }).success).toBe(false);
    expect(CompiledGeneratedUiArtifactSchema.safeParse({ ...artifact, module: { ...artifact.module, value: Buffer.from("tampered").toString("base64") } }).success).toBe(false);
    expect(CompiledGeneratedUiArtifactSchema.safeParse({ ...artifact, implementationPromptDigest: "0".repeat(64) }).success).toBe(false);
  });
});
