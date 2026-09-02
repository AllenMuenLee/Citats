import { describe, expect, it } from "vitest";
import { CompiledGeneratedUiArtifactSchema, digestUiGenerationRequest, UiGenerationRequestSchema, type GeneratedUiArtifactManifest, type UiGenerationResponse } from "@ai-browser/contracts";
import requestFixture from "../../../../../packages/contracts/fixtures/ui-generation-request/valid-1.json";
import { GeneratedUiInstanceStore } from "./instance-store";
import { createAdaptiveGeneratedUi } from "./flow";

const request = UiGenerationRequestSchema.parse(requestFixture);
const manifest: GeneratedUiArtifactManifest = {
  planDigest: request.planDigest, sourceIds: request.plan.sources.map((item) => item.sourceId), recordIds: [], factIds: [], mediaIds: [], componentIds: [], localInteractions: [],
  accessibilityFeatures: ["heading_order"], responsiveRegions: ["main"], runtimeImports: ["GeneratedViewProps", "Card", "Heading"], fallback: false,
};
const source = `import { type GeneratedViewProps, Card, Heading } from "@ai-browser/generated-ui-runtime";
export default function GeneratedView(_props: GeneratedViewProps) { return <Card aria-label="Results"><Heading>Results</Heading></Card>; }`;

function response(overrides: Partial<UiGenerationResponse> = {}): UiGenerationResponse {
  return { schemaVersion: 1, tsxSource: source, manifest, modelIdentifier: "ui-model-pinned", promptDigest: request.promptDigest, inputDigest: digestUiGenerationRequest(request), runtimeVersion: request.runtime.apiVersion, toolchainVersion: "test", fallbackReason: null, ...overrides };
}

describe("adaptive generated UI flow", () => {
  it("compiles, registers, and stores only an artifact reference and display-safe bindings", async () => {
    const artifacts: unknown[] = [];
    const instances = new GeneratedUiInstanceStore(() => 1_000, () => "instance-1");
    const result = await createAdaptiveGeneratedUi({ generate: async () => response(), registerArtifact: (artifact) => artifacts.push(artifact), instances, now: () => 1_000 }, { ownerId: "owner-1", request });
    expect(result.fallbackReason).toBeNull();
    expect(result.reference).toMatchObject({ instanceId: "instance-1", revision: 0, planDigest: request.planDigest });
    expect(JSON.stringify(result.reference)).not.toContain("tsxSource");
    expect(artifacts).toHaveLength(1);
    expect(instances.get("instance-1", "owner-1")).toBeDefined();
  });

  it("falls back to trusted text when validation or generation fails", async () => {
    const result = await createAdaptiveGeneratedUi({ generate: async () => { throw new Error("provider details"); }, registerArtifact: () => { throw new Error("should not register"); }, instances: new GeneratedUiInstanceStore() }, { ownerId: "owner-1", request });
    expect(result.reference).toBeNull();
    expect(result.fallbackReason).toBe("generation_failed");
    expect(result.fallbackText).not.toContain("provider details");
  });

  it("accepts only an identity-bound ready handshake", () => {
    const instances = new GeneratedUiInstanceStore(() => 1_000, () => "instance-1");
    const artifact = CompiledGeneratedUiArtifactSchema.parse({ schemaVersion: 1, artifactId: `gui_${"a".repeat(64)}`, module: { kind: "bytes", encoding: "base64", value: "YQ==" }, manifest, validation: { valid: true, issues: [] }, sourceMapPolicy: "omitted", planDigest: request.planDigest, inputDigest: "b".repeat(64), promptDigest: request.promptDigest, modelDigest: "c".repeat(64), toolchainDigest: "d".repeat(64), expiresAt: "2030-01-01T00:00:00Z", fallbackText: "fallback" });
    const instance = instances.register({ ownerId: "owner-1", artifact, planDigest: request.planDigest, inputDigest: artifact.inputDigest, expiresAt: Date.parse(artifact.expiresAt), preservedStateKeys: [], displayProps: { goal: "g", sources: [], collections: [], records: [], facts: [], media: [], coverage: {} } });
    expect(instances.markReady({ instanceId: instance.instanceId, ownerId: "owner-1", artifactId: "forged", planDigest: request.planDigest, revision: 0 })).toBe(false);
    expect(instances.markReady({ instanceId: instance.instanceId, ownerId: "owner-1", artifactId: artifact.artifactId, planDigest: request.planDigest, revision: 0 })).toBe(true);
  });
});
