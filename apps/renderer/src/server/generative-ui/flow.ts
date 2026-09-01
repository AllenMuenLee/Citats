import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { CompiledGeneratedUiArtifact, UiGenerationRequest, UiGenerationResponse } from "@ai-browser/contracts";
import { compileGeneratedUi, GeneratedUiCompilationError } from "./compiler";
import { capabilitySchemasForRequest, GeneratedUiInstanceStore } from "./instance-store";

export type GeneratedUiReference = Readonly<{
  instanceId: string;
  artifactId: string;
  inputDigest: string;
  observationDigest: string;
  revision: number;
  expiresAt: string;
  displayProps: Readonly<Record<string, unknown>>;
  sourceCount: number;
  coverageLabel: string;
  fallbackText: string;
}>;

export interface AdaptiveUiFlowDependencies {
  generate(request: UiGenerationRequest, signal?: AbortSignal): Promise<UiGenerationResponse>;
  registerArtifact(artifact: CompiledGeneratedUiArtifact): void;
  instances: GeneratedUiInstanceStore;
  now?: () => number;
  ttlMs?: number;
}

function trustedFallback(request: UiGenerationRequest): string {
  const notes = request.coverage.notes.slice(0, 3).join(" ");
  return notes || `Generated view unavailable. ${request.sourceBindings.length} validated source${request.sourceBindings.length === 1 ? " is" : "s are"} available.`;
}

function displayProps(request: UiGenerationRequest): Readonly<Record<string, unknown>> {
  return Object.freeze({
    records: request.recordBindings.map((record) => ({ id: record.recordId, collectionId: record.collectionId })),
    sources: request.sourceBindings.map((source) => ({ id: source.sourceId, provider: source.provider, label: source.displayLabel })),
    media: request.mediaBindings.map((media) => ({ id: media.mediaId, kind: media.kind, altText: media.altText, safeReference: media.safeReference })),
    capabilities: request.capabilityBindings.map((capability) => ({
      id: capability.capabilityId,
      allowedCommandKinds: capability.allowedCommandKinds,
      execution: capability.interactionExecution,
      promptTemplateId: capability.promptTemplateId,
    })),
  });
}

export async function createAdaptiveGeneratedUi(
  dependencies: AdaptiveUiFlowDependencies,
  input: { ownerId: string; request: UiGenerationRequest; observationDigest: string; signal?: AbortSignal },
): Promise<{ reference: GeneratedUiReference | null; fallbackText: string; fallbackReason: string | null }> {
  const fallbackText = trustedFallback(input.request);
  try {
    const response = await dependencies.generate(input.request, input.signal);
    if (!response.tsxSource || response.fallbackReason) {
      console.error("[generative-ui] UI generation returned no usable source", { fallbackReason: response.fallbackReason, hasSource: Boolean(response.tsxSource) });
      return { reference: null, fallbackText, fallbackReason: response.fallbackReason ?? "generation_failed" };
    }
    const compiled = compileGeneratedUi({ source: response.tsxSource, manifest: response.manifest, limits: input.request.limits, allowedTokens: input.request.theme.allowedTokens });
    const modelDigest = createHash("sha256").update(response.modelIdentifier).digest("hex");
    const toolchainDigest = createHash("sha256").update(compiled.toolchainVersion).digest("hex");
    const artifactHash = createHash("sha256").update(compiled.bytes).update(response.inputDigest).update(response.promptDigest).update(modelDigest).update(toolchainDigest).digest("hex");
    const now = dependencies.now?.() ?? Date.now();
    const expiresAt = new Date(now + (dependencies.ttlMs ?? 15 * 60_000)).toISOString();
    const artifact: CompiledGeneratedUiArtifact = {
      schemaVersion: 1,
      artifactId: `gui_${artifactHash}`,
      module: { kind: "bytes", encoding: "base64", value: Buffer.from(compiled.bytes).toString("base64") },
      manifest: response.manifest,
      validation: { valid: true, issues: compiled.validation.issues.map(({ code, severity, location }) => ({ code, severity, location })) },
      sourceMapPolicy: "omitted",
      inputDigest: response.inputDigest,
      promptDigest: response.promptDigest,
      modelDigest,
      toolchainDigest,
      expiresAt,
      fallbackText,
    };
    dependencies.registerArtifact(artifact);
    const props = displayProps(input.request);
    const instance = dependencies.instances.register({ ownerId: input.ownerId, artifact, request: input.request, observationDigest: input.observationDigest, expiresAt: Date.parse(expiresAt), capabilities: capabilitySchemasForRequest(input.request), preservedStateKeys: response.manifest.localInteractions.map((item) => item.stateKey), displayProps: props });
    return { reference: { instanceId: instance.instanceId, artifactId: artifact.artifactId, inputDigest: artifact.inputDigest, observationDigest: input.observationDigest, revision: instance.revision, expiresAt, displayProps: props, sourceCount: input.request.sourceBindings.length, coverageLabel: input.request.coverage.unknownControlCount > 0 || input.request.coverage.inaccessibleRegionCount > 0 ? "Partial coverage" : "Validated coverage", fallbackText }, fallbackText, fallbackReason: null };
  } catch (error) {
    // Never surfaced to the model or the client beyond a generic fallback
    // (the whole point of `reference: null` is a safe, silent degrade) --
    // but that means this is the only place the real cause is observable
    // at all, so it must be logged here rather than only carried in the
    // return value.
    console.error("[generative-ui] UI generation failed", error);
    return { reference: null, fallbackText, fallbackReason: error instanceof GeneratedUiCompilationError ? "compilation_failed" : "generation_failed" };
  }
}
