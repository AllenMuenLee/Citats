import { describe, expect, it } from "vitest";
import requestFixture from "../fixtures/ui-generation-request/valid-1.json";
import {
  UiGenerationRequestSchema,
  UiGenerationResponseSchema,
  canonicalizeUiGenerationRequest,
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

  it("sorts semantically unordered bindings but preserves graph source order", () => {
    const a = { ...request, theme: { ...request.theme, allowedTokens: ["surface", "canvas"] } };
    expect(digestUiGenerationRequest(a)).toBe(digestUiGenerationRequest(request));
    const withNodes = { ...request, graph: { ...request.graph, nodes: [
      { kind: "text", handle: "n-1", boundingBox: null, visibility: "visible", role: "paragraph", text: "one", headingLevel: null },
      { kind: "text", handle: "n-2", boundingBox: null, visibility: "visible", role: "paragraph", text: "two", headingLevel: null },
    ] } };
    const reversed = { ...withNodes, graph: { ...withNodes.graph, nodes: [...withNodes.graph.nodes].reverse() } };
    expect(digestUiGenerationRequest(UiGenerationRequestSchema.parse(withNodes))).not.toBe(digestUiGenerationRequest(UiGenerationRequestSchema.parse(reversed)));
  });

  it("rejects fallback/source disagreement and forged manifest references", () => {
    const base = {
      schemaVersion: 1, tsxSource: null,
      manifest: { observationIds: ["forged"], sourceIds: [], recordIds: [], mediaIds: [], capabilityIds: [], emittedCommandKinds: [], localInteractions: [], accessibilityFeatures: [], responsiveRegions: [], runtimeImports: [], fallback: true },
      modelIdentifier: "model", promptDigest: request.promptDigest, inputDigest: digestUiGenerationRequest(request), runtimeVersion: "1", toolchainVersion: "1", fallbackReason: "insufficient_evidence",
    };
    expect(UiGenerationResponseSchema.safeParse({ ...base, tsxSource: "x" }).success).toBe(false);
    expect(() => validateUiGenerationResponseForRequest(request, base)).toThrow(/forged/);
  });

  it("rejects source over the UTF-8 byte bound", () => {
    const response = { schemaVersion: 1, tsxSource: "é".repeat(40_000), manifest: { observationIds: ["obs-1"], sourceIds: [], recordIds: [], mediaIds: [], capabilityIds: [], emittedCommandKinds: [], localInteractions: [], accessibilityFeatures: [], responsiveRegions: [], runtimeImports: [], fallback: false }, modelIdentifier: "model", promptDigest: "a".repeat(64), inputDigest: "b".repeat(64), runtimeVersion: "1", toolchainVersion: "1", fallbackReason: null };
    expect(UiGenerationResponseSchema.safeParse(response).success).toBe(false);
  });
});
