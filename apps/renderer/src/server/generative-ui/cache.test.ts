import { describe, expect, it } from "vitest";
import { ImmutableUiArtifactCache, uiArtifactCacheKey, type UiArtifactCacheIdentity } from "./cache";

const identity: UiArtifactCacheIdentity = { tenantId: "tenant-a", userId: "user-a", inputDigest: "a".repeat(64), promptDigest: "b".repeat(64), modelIdentifier: "pinned-model", runtimeVersion: "1", compilerVersion: "1" };
function artifact(valid = true) { const planDigest = "f".repeat(64); return { schemaVersion: 1, artifactId: `gui_${"c".repeat(64)}`, module: { kind: "bytes", encoding: "base64", value: "YQ==" }, manifest: { planDigest, sourceIds: [], recordIds: [], factIds: [], mediaIds: [], componentIds: [], localInteractions: [], accessibilityFeatures: [], responsiveRegions: [], runtimeImports: [], fallback: false }, validation: { valid, issues: valid ? [] : [{ code: "INVALID", severity: "error", location: null }] }, sourceMapPolicy: "omitted", planDigest, inputDigest: identity.inputDigest, promptDigest: identity.promptDigest, modelDigest: "d".repeat(64), toolchainDigest: "e".repeat(64), expiresAt: "2030-01-01T00:00:00Z", fallbackText: null }; }

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
    expect(() => cache.putValidated({ ...identity, inputDigest: "f".repeat(64) }, artifact(false))).toThrow(/validated/);
  });
});
