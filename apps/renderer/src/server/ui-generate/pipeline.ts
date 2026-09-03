import "server-only";

import { uiGenerateFailure, type UiGenerateResult } from "@ai-browser/contracts";
import {
  UiGenerateStageError,
  type CaptureStage,
  type GenerationStage,
  type PlanningStage,
  type RenderStage,
  type SourceFindingStage,
  type UiGenerateContext,
} from "./types";

/**
 * The one `ui.generate` entry point (P02-F03, P04-F05 step 1).
 *
 * The stage order is this function body and nothing else:
 *
 *   source finding -> ordered Playwright captures -> UI planning ->
 *   UI generation -> validation/typecheck/compile -> registration ->
 *   mount -> ready handshake
 *
 * No model can add, omit, reorder, or invoke a stage. There is exactly one
 * terminal result per execution, progress is emitted in the fixed order,
 * and only a real ready handshake produces `ready` -- a registered
 * artifact, a mounted surface, or a successful model call is not readiness.
 */

export interface UiGeneratePipelineDependencies {
  readonly sourceFinding: SourceFindingStage;
  readonly capture: CaptureStage;
  readonly planning: PlanningStage;
  readonly generation: GenerationStage;
  readonly render: RenderStage;
}

export type UiGeneratePipeline = (request: string, context: UiGenerateContext) => Promise<UiGenerateResult>;

/**
 * Maps any stage failure onto exactly one closed category. Nothing from a
 * provider, a page, or a browser is ever read here -- only the typed
 * category the stage itself declared.
 */
function toResult(error: unknown, signal: AbortSignal): UiGenerateResult {
  if (error instanceof UiGenerateStageError) return uiGenerateFailure(error.category);
  if (signal.aborted) return uiGenerateFailure("cancelled");
  console.error("[ui.generate] pipeline failed", error);
  return uiGenerateFailure("internal");
}

export function createUiGeneratePipeline(dependencies: UiGeneratePipelineDependencies): UiGeneratePipeline {
  return async function generateUi(request: string, context: UiGenerateContext): Promise<UiGenerateResult> {
    const { signal, correlationId, ownerId } = context;
    let mountedInstanceId: string | null = null;
    try {
      if (signal.aborted) return uiGenerateFailure("cancelled");

      context.emitProgress("source_finding");
      const sources = await dependencies.sourceFinding.find({ request, correlationId, signal });
      context.trace?.("ui-generate-sources", {
        count: sources.length,
        origins: sources.map((source) => source.origin),
        urls: sources.map((source) => source.url),
      });

      context.emitProgress("page_capture");
      const { captures, failures } = await dependencies.capture.capture({ sources, correlationId, signal });
      context.trace?.("ui-generate-captures", { captured: captures.length, failures: failures.map((failure) => failure.category) });

      context.emitProgress("ui_planning");
      const { implementationPrompt, trustedSources } = await dependencies.planning.plan({ request, captures, correlationId, signal });
      context.trace?.("ui-generate-plan", { implementationPromptChars: implementationPrompt.length, trustedSources: trustedSources.length });

      // Generation, validation/compilation, and registration are one stage
      // boundary from the caller's side but two progress states, because the
      // second is where a well-formed but unsafe component is rejected.
      context.emitProgress("ui_generation");
      context.emitProgress("validation");
      const view = await dependencies.generation.generate({
        implementationPrompt,
        trustedSources,
        requestedSourceCount: sources.length,
        request,
        ownerId,
        correlationId,
        signal,
      });
      mountedInstanceId = view.instanceId;

      // The renderer is handed the instance only now, and readiness is what
      // it reports back. Emitting the view is not the result.
      context.emitProgress("rendering");
      context.emitView(view);
      const ready = await dependencies.render.awaitReady({ instanceId: view.instanceId, signal });
      if (!ready) {
        dependencies.render.destroy({ instanceId: view.instanceId, ownerId });
        mountedInstanceId = null;
        context.trace?.("ui-generate-not-ready", { instanceId: view.instanceId });
        return uiGenerateFailure(signal.aborted ? "cancelled" : "render_failed");
      }
      mountedInstanceId = null;
      context.trace?.("ui-generate-ready", { instanceId: view.instanceId, sourceCount: view.sourceCount });
      return {
        status: "ready",
        viewRef: view.viewRef,
        title: view.title,
        sourceCount: view.sourceCount,
        coverage: view.coverage,
      };
    } catch (error) {
      return toResult(error, signal);
    } finally {
      // Any partial UI left behind by a failure or a cancellation is removed
      // rather than left mounted with nothing behind it.
      if (mountedInstanceId !== null) dependencies.render.destroy({ instanceId: mountedInstanceId, ownerId });
    }
  };
}
