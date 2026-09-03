import "server-only";

import type { ModelRoleConfig } from "../../ai/config";
import { createTextCompletion } from "../../ai";
import { registerGeneratedUiArtifact } from "../../generative-ui/bridge/artifact-store";
import { createAdaptiveGeneratedUi } from "../../generative-ui/flow";
import { generatedUiInstances, type GeneratedUiInstanceStore } from "../../generative-ui/instance-store";
import { buildUiGenerationRequest } from "../../generative-ui/request-builder";
import { createUiGenerationAdapter } from "../../generative-ui/ui-adapter";
import { compileGeneratedUi, GeneratedUiCompilationError, GENERATED_UI_TOOLCHAIN_VERSION, validateGeneratedUiSource } from "../../generative-ui/compiler";
import { UI_PLANNING_PROMPT_DIGEST, UI_PLANNING_PROMPT_VERSION } from "../planning/system-prompt";
import { UiGenerateStageError, type GenerationStage, type RegisteredView, type RenderStage } from "../types";

/**
 * Stage 4 of `ui.generate`: `UI_MODEL` writes the component, trusted code
 * validates, compiles, content-addresses, and registers it (P04-F02,
 * P04-F05 step 1).
 *
 * Nothing here reads the implementation prompt for policy: the request
 * builder fixes the runtime, theme, and limits, and the compiler and static
 * validator decide what is safe. The model's contribution is source and a
 * manifest, both of which have to agree with the request and the generated
 * code before anything is registered.
 */
export interface GenerationStageOptions {
  readonly role: ModelRoleConfig;
  readonly instances?: GeneratedUiInstanceStore;
  readonly ttlMs?: number;
  readonly log?: (line: Record<string, unknown>) => void;
}

export function createGenerationStage(options: GenerationStageOptions): GenerationStage {
  const instances = options.instances ?? generatedUiInstances;
  const transport = createTextCompletion(options.role);
  return {
    async generate({ implementationPrompt, trustedSources, requestedSourceCount, request: trustedRequest, ownerId, correlationId, signal }): Promise<RegisteredView> {
      const request = buildUiGenerationRequest({
        implementationPrompt,
        trustedRequest,
        trustedSources,
        plannerPromptVersion: UI_PLANNING_PROMPT_VERSION,
        plannerPromptDigest: UI_PLANNING_PROMPT_DIGEST,
        requestId: correlationId,
        userId: ownerId,
      });
      const adapter = createUiGenerationAdapter({
        model: options.role.model,
        compilerVersion: GENERATED_UI_TOOLCHAIN_VERSION,
        // Groq's completion ceiling is far lower than Gemini's, so the budget
        // follows the provider rather than being one number that is wrong for
        // one of them.
        maxTokens: options.role.provider === "groq" ? 8_000 : 24_000,
        transport,
        emitMetric: (metric) => {
          const line = { stage: "ui_generation", correlationId, model: options.role.model, ...metric };
          if (metric.validationCategory === "accepted") options.log?.(line);
          else options.log?.({ ...line, outcome: "no_view" });
        },
        validate: async (response) => {
          if (!response.tsxSource) return [];
          const input = {
            source: response.tsxSource,
            manifest: response.manifest,
            limits: request.limits,
            allowedTokens: request.theme.allowedTokens,
          };
          const staticErrors = validateGeneratedUiSource(input).issues.filter((issue) => issue.severity === "error");
          if (staticErrors.length > 0) return staticErrors;
          // The type-check and transpile the compiler runs are also a gate the
          // model gets one repair attempt against: a well-formed component
          // that calls a runtime export with the wrong shape comes back as
          // normalized codes rather than dying uncaught at registration.
          try {
            compileGeneratedUi(input);
            return [];
          } catch (error) {
            if (error instanceof GeneratedUiCompilationError) {
              const details = error.details;
              return error.codes.map((code, index) => ({
                code,
                ...(details[index] ? { message: details[index] } : {}),
              }));
            }
            throw error;
          }
        },
      });
      const generated = await createAdaptiveGeneratedUi(
        { generate: adapter.generate, registerArtifact: registerGeneratedUiArtifact, instances, ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }) },
        { ownerId, request, requestedSourceCount, signal },
      );
      if (!generated.reference) {
        if (signal.aborted) throw new UiGenerateStageError("cancelled", "UI generation was cancelled");
        throw new UiGenerateStageError(
          generated.fallbackReason === "compilation_failed" || generated.fallbackReason === "validation_failed"
            ? "validation_failed"
            : "generation_failed",
          "No usable generated view was produced",
        );
      }
      const { reference } = generated;
      return {
        instanceId: reference.instanceId,
        viewRef: reference.viewRef,
        artifactId: reference.artifactId,
        implementationPromptDigest: reference.implementationPromptDigest,
        inputDigest: reference.inputDigest,
        revision: reference.revision,
        expiresAt: reference.expiresAt,
        title: reference.title,
        sourceCount: reference.sourceCount,
        coverage: reference.coverage,
        fallbackText: reference.fallbackText,
      };
    },
  };
}

/**
 * Stage 5: the ready handshake. Readiness is owned by the instance store,
 * which only records it for a handshake whose instance, owner, artifact,
 * plan digest, and revision all match server-held state.
 */
export function createRenderStage(instances: GeneratedUiInstanceStore = generatedUiInstances): RenderStage {
  return {
    awaitReady: (input) => instances.waitForReady(input),
    destroy: ({ instanceId, ownerId }) => instances.destroy(instanceId, ownerId),
  };
}
