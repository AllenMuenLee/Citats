import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeGeneratedUiArtifactId } from "@ai-browser/contracts";
import { ImmutableUiArtifactCache, uiArtifactCacheKey, type UiArtifactCacheIdentity } from "./cache";

const identity: UiArtifactCacheIdentity = { tenantId: "tenant-a", userId: "user-a", inputDigest: "a".repeat(64), promptDigest: "b".repeat(64), modelIdentifier: "pinned-model", runtimeVersion: "1", compilerVersion: "1" };
function digest(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function artifact(valid = true) {
  const implementationPromptDigest = "e".repeat(64);
  const bytes = Buffer.from("a");
  const modelDigest = digest(identity.modelIdentifier);
  const toolchainDigest = digest(identity.compilerVersion);
  return {
    schemaVersion: 1,
    artifactId: computeGeneratedUiArtifactId({ bytes, implementationPromptDigest, inputDigest: identity.inputDigest, promptDigest: identity.promptDigest, modelDigest, toolchainDigest }),
    module: { kind: "bytes", encoding: "base64", value: bytes.toString("base64") },
    manifest: { sourceIds: [], localInteractions: [], accessibilityFeatures: [], responsiveRegions: [], runtimeImports: [], fallback: false },
    validation: { valid, issues: valid ? [] : [{ code: "INVALID", severity: "error", location: null }] },
    sourceMapPolicy: "omitted",
    implementationPromptDigest,
    inputDigest: identity.inputDigest,
    promptDigest: identity.promptDigest,
    modelDigest,
    toolchainDigest,
    expiresAt: "2030-01-01T00:00:00Z",
    fallbackText: "This generated view is unavailable.",
  };
}

describe("immutable generated artifact cache", () => {
  it("invalidates keys on every model/runtime/prompt/compiler input", () => {
    const base = uiArtifactCacheKey(identity);
    for (const change of [{ modelIdentifier: "other" }, { runtimeVersion: "2" }, { compilerVersion: "2" }, { promptDigest: "f".repeat(64) }]) expect(uiArtifactCacheKey({ ...identity, ...change })).not.toBe(base);
  });
  it("stores validated artifacts only and isolates tenant/user visibility", () => {
    const cache = new ImmutableUiArtifactCache({ maxEntries: 2, maxBytes: 100_000, ttlMs: 1_000_000, now: () => 1 });
    cache.putValidated(identity, artifact());
    expect(cache.get(identity)?.artifactId).toMatch(/^gui_/);
    expect(cache.get({ ...identity, userId: "user-b" })).toBeUndefined();
    expect(() => cache.putValidated({ ...identity, inputDigest: "f".repeat(64) }, artifact(false))).toThrow(/validation/);
    expect(() => cache.putValidated({ ...identity, modelIdentifier: "other" }, artifact())).toThrow(/identity/);
  });
});
