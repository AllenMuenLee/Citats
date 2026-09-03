import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  computeGeneratedUiArtifactId,
  type CompiledGeneratedUiArtifact,
  type UiGenerationRequest,
  type UiGenerationResponse,
} from "@ai-browser/contracts";
import { compileGeneratedUi, GeneratedUiCompilationError } from "./compiler";
import { displayPropsForSources, type GeneratedUiInstanceStore, type GeneratedViewDisplayProps } from "./instance-store";

/**
 * Generation -> validation/compilation -> content-addressed artifact ->
 * registration (P04-F01 step 3, P04-F05 step 1).
 *
 * Raw model output is never registered and never served. What is stored is
 * the compiled bytes plus the digests that pin them to one implementation
 * prompt, both versioned policies, one model, and one toolchain -- so an
 * artifact can only ever be served back for the exact inputs that produced
 * it.
 */

export type GeneratedUiReference = Readonly<{
  instanceId: string;
  viewRef: string;
  artifactId: string;
  implementationPromptDigest: string;
  inputDigest: string;
  revision: number;
  expiresAt: string;
  displayProps: GeneratedViewDisplayProps;
  title: string;
  sourceCount: number;
  coverage: "validated" | "partial";
  fallbackText: string;
}>;

export interface AdaptiveUiFlowDependencies {
  generate(request: UiGenerationRequest, signal?: AbortSignal): Promise<UiGenerationResponse>;
  registerArtifact(artifact: CompiledGeneratedUiArtifact): void;
  instances: GeneratedUiInstanceStore;
  now?: () => number;
  ttlMs?: number;
}

export interface AdaptiveUiFlowInput {
  ownerId: string;
  request: UiGenerationRequest;
  /** How many sources source-finding proposed, so coverage can report `partial` when captures fell short. */
  requestedSourceCount: number;
  signal?: AbortSignal;
}

/**
 * The trusted fallback shown when the generated component cannot render. It
 * is authored from the trusted request and the trusted source records, not
 * from the implementation prompt or the model, so it stays truthful even
 * when generation was the thing that failed.
 */
function trustedFallback(request: UiGenerationRequest, requestedSourceCount: number): string {
  const captured = request.trustedSources.length;
  const sources = `${captured} of ${Math.max(captured, requestedSourceCount)} source${requestedSourceCount === 1 ? "" : "s"} captured`;
  return `Generated view unavailable for "${request.trustedRequest.slice(0, 120)}". ${sources}.`;
}

/** A short, display-safe title for the pane and for the chat model's confirmation. Trusted request only. */
function viewTitle(request: UiGenerationRequest): string {
  return request.trustedRequest.trim().slice(0, 120) || "Generated view";
}

export async function createAdaptiveGeneratedUi(
  dependencies: AdaptiveUiFlowDependencies,
  input: AdaptiveUiFlowInput,
): Promise<{ reference: GeneratedUiReference | null; fallbackText: string; fallbackReason: string | null }> {
  const fallbackText = trustedFallback(input.request, input.requestedSourceCount);
  try {
    const response = await dependencies.generate(input.request, input.signal);
    if (!response.tsxSource || response.fallbackReason) {
      console.error("[generative-ui] UI generation returned no usable source", {
        fallbackReason: response.fallbackReason,
        hasSource: Boolean(response.tsxSource),
      });
      return { reference: null, fallbackText, fallbackReason: response.fallbackReason ?? "generation_failed" };
    }
    const compiled = compileGeneratedUi({
      source: response.tsxSource,
      manifest: response.manifest,
      limits: input.request.limits,
      allowedTokens: input.request.theme.allowedTokens,
    });
    const modelDigest = createHash("sha256").update(response.modelIdentifier).digest("hex");
    const toolchainDigest = createHash("sha256").update(compiled.toolchainVersion).digest("hex");
    const artifactId = computeGeneratedUiArtifactId({
      bytes: compiled.bytes,
      implementationPromptDigest: input.request.implementationPromptDigest,
      inputDigest: response.inputDigest,
      promptDigest: response.promptDigest,
      modelDigest,
      toolchainDigest,
    });
    const now = dependencies.now?.() ?? Date.now();
    const expiresAtMs = now + (dependencies.ttlMs ?? 15 * 60_000);
    const expiresAt = new Date(expiresAtMs).toISOString();
    const artifact: CompiledGeneratedUiArtifact = {
      schemaVersion: 1,
      artifactId,
      module: { kind: "bytes", encoding: "base64", value: Buffer.from(compiled.bytes).toString("base64") },
      manifest: response.manifest,
      validation: { valid: true, issues: compiled.validation.issues.map(({ code, severity, location }) => ({ code, severity, location })) },
      sourceMapPolicy: "omitted",
      implementationPromptDigest: input.request.implementationPromptDigest,
      inputDigest: response.inputDigest,
      promptDigest: response.promptDigest,
      modelDigest,
      toolchainDigest,
      expiresAt,
      fallbackText,
    };
    dependencies.registerArtifact(artifact);
    const displayProps = displayPropsForSources({
      goal: input.request.trustedRequest,
      trustedSources: input.request.trustedSources,
      requestedSourceCount: input.requestedSourceCount,
    });
    const instance = dependencies.instances.register({
      ownerId: input.ownerId,
      artifact,
      implementationPromptDigest: input.request.implementationPromptDigest,
      inputDigest: artifact.inputDigest,
      expiresAt: expiresAtMs,
      displayProps,
      preservedStateKeys: response.manifest.localInteractions.map((item) => item.stateKey),
    });
    const coverage: "validated" | "partial" =
      input.request.trustedSources.length < input.requestedSourceCount ||
      input.request.trustedSources.some((source) => source.captureStatus !== "complete")
        ? "partial"
        : "validated";
    return {
      reference: {
        instanceId: instance.instanceId,
        viewRef: instance.viewRef,
        artifactId: artifact.artifactId,
        implementationPromptDigest: artifact.implementationPromptDigest,
        inputDigest: artifact.inputDigest,
        revision: instance.revision,
        expiresAt,
        displayProps,
        title: viewTitle(input.request),
        sourceCount: input.request.trustedSources.length,
        coverage,
        fallbackText,
      },
      fallbackText,
      fallbackReason: null,
    };
  } catch (error) {
    // `reference: null` is a deliberately silent degrade for the client, so
    // this is the only place the real cause is observable at all.
    console.error("[generative-ui] UI generation failed", error);
    return {
      reference: null,
      fallbackText,
      fallbackReason: error instanceof GeneratedUiCompilationError ? "compilation_failed" : "generation_failed",
    };
  }
}
