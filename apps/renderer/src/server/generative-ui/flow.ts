import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { CompiledGeneratedUiArtifact, UiGenerationRequest, UiGenerationResponse } from "@ai-browser/contracts";
import { compileGeneratedUi, GeneratedUiCompilationError } from "./compiler";
import { displayPropsForPlan, type GeneratedUiInstanceStore, type GeneratedViewDisplayProps } from "./instance-store";

/**
 * Generation -> validation/compilation -> content-addressed artifact ->
 * registration (P04-F01 step 3, P04-F05 step 1).
 *
 * Raw model output is never registered and never served. What is stored is
 * the compiled bytes plus the digests that pin them to one plan, one
 * prompt, one model, and one toolchain -- so an artifact can only ever be
 * served back for the exact inputs that produced it.
 */

export type GeneratedUiReference = Readonly<{
  instanceId: string;
  viewRef: string;
  artifactId: string;
  planDigest: string;
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

/**
 * The trusted fallback shown when the generated component cannot render.
 * It is authored from the plan, not by the model, so it stays truthful even
 * when generation was the thing that failed.
 */
function trustedFallback(request: UiGenerationRequest): string {
  const { plan } = request;
  const notes = [...plan.coverage.omissions, ...plan.coverage.unsupportedRequests].slice(0, 3).join(" ");
  const sources = `${plan.sources.length} validated source${plan.sources.length === 1 ? "" : "s"}`;
  return notes ? `Generated view unavailable. ${sources}. ${notes}` : `Generated view unavailable. ${sources}.`;
}

/** A short, display-safe title for the pane and for the chat model's confirmation. */
function viewTitle(request: UiGenerationRequest): string {
  const root = request.plan.components.find((component) => component.role === "root");
  const candidate = (root?.label ?? request.plan.informationArchitecture.primaryEntity ?? "Generated view").trim();
  return candidate.slice(0, 120) || "Generated view";
}

export async function createAdaptiveGeneratedUi(
  dependencies: AdaptiveUiFlowDependencies,
  input: { ownerId: string; request: UiGenerationRequest; signal?: AbortSignal },
): Promise<{ reference: GeneratedUiReference | null; fallbackText: string; fallbackReason: string | null }> {
  const fallbackText = trustedFallback(input.request);
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
    const artifactHash = createHash("sha256")
      .update(compiled.bytes)
      .update(response.inputDigest)
      .update(response.promptDigest)
      .update(modelDigest)
      .update(toolchainDigest)
      .digest("hex");
    const now = dependencies.now?.() ?? Date.now();
    const expiresAtMs = now + (dependencies.ttlMs ?? 15 * 60_000);
    const expiresAt = new Date(expiresAtMs).toISOString();
    const artifact: CompiledGeneratedUiArtifact = {
      schemaVersion: 1,
      artifactId: `gui_${artifactHash}`,
      module: { kind: "bytes", encoding: "base64", value: Buffer.from(compiled.bytes).toString("base64") },
      manifest: response.manifest,
      validation: { valid: true, issues: compiled.validation.issues.map(({ code, severity, location }) => ({ code, severity, location })) },
      sourceMapPolicy: "omitted",
      planDigest: input.request.planDigest,
      inputDigest: response.inputDigest,
      promptDigest: response.promptDigest,
      modelDigest,
      toolchainDigest,
      expiresAt,
      fallbackText,
    };
    dependencies.registerArtifact(artifact);
    const displayProps = displayPropsForPlan(input.request.plan);
    const instance = dependencies.instances.register({
      ownerId: input.ownerId,
      artifact,
      planDigest: input.request.planDigest,
      inputDigest: artifact.inputDigest,
      expiresAt: expiresAtMs,
      displayProps,
      preservedStateKeys: response.manifest.localInteractions.map((item) => item.stateKey),
    });
    const coverage: "validated" | "partial" =
      input.request.plan.coverage.capturedSources < input.request.plan.coverage.requestedSources ||
      input.request.plan.coverage.omissions.length > 0 ||
      input.request.plan.coverage.unsupportedRequests.length > 0
        ? "partial"
        : "validated";
    return {
      reference: {
        instanceId: instance.instanceId,
        viewRef: instance.viewRef,
        artifactId: artifact.artifactId,
        planDigest: artifact.planDigest,
        inputDigest: artifact.inputDigest,
        revision: instance.revision,
        expiresAt,
        displayProps,
        title: viewTitle(input.request),
        sourceCount: input.request.plan.sources.length,
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
