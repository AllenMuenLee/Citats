import "server-only";

import type {
  UiGenerateFailureCategory,
  UiGenerateProgressState,
  UiGenerateResult,
  UiPlan,
} from "@ai-browser/contracts";

/**
 * The typed internal interfaces of the fixed `ui.generate` pipeline
 * (P02-F03 step 3).
 *
 * These are ordinary code calls between trusted stages. **None of them is
 * ever sent to a model as a tool definition**, and no model can add, omit,
 * reorder, or invoke a stage: the order lives in `pipeline.ts` as a
 * straight-line sequence, not as anything a model can influence.
 */

/** One website the source-finding model proposed, after trusted validation. */
export interface ValidatedSource {
  /** Stable plan id minted in returned order (`src-1`, `src-2`, ...). */
  readonly sourceId: string;
  /** Normalized absolute URL, credential-free and fragment-free. */
  readonly url: string;
  readonly origin: string;
  /** The model's stated reason, kept only for safe logging -- never sent onward as an instruction. */
  readonly reason: string;
}

/**
 * One successful rendered-HTML capture. `html` is sanitized, bounded, and
 * strictly request-scoped: it reaches the planning model and nothing else --
 * not chat, not the renderer, not telemetry, not artifact storage.
 */
export interface PageCapture {
  readonly sourceId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly origin: string;
  readonly title: string;
  readonly contentType: string;
  readonly retrievedAt: string;
  readonly retrievalMs: number;
  readonly html: string;
  /** Whether the serialized DOM was cut to fit the per-capture byte bound. */
  readonly truncated: boolean;
}

export interface CaptureOutcome {
  readonly captures: readonly PageCapture[];
  /** Per-source failure categories, for safe logging only. */
  readonly failures: readonly { readonly sourceId: string; readonly category: string }[];
}

export interface SourceFindingStage {
  find(input: { request: string; correlationId: string; signal: AbortSignal }): Promise<readonly ValidatedSource[]>;
}

export interface CaptureStage {
  capture(input: { sources: readonly ValidatedSource[]; correlationId: string; signal: AbortSignal }): Promise<CaptureOutcome>;
}

export interface PlanningStage {
  plan(input: { request: string; captures: readonly PageCapture[]; correlationId: string; signal: AbortSignal }): Promise<UiPlan>;
}

/** What the generation + validation + registration stages hand to rendering. */
export interface RegisteredView {
  readonly instanceId: string;
  readonly viewRef: string;
  readonly artifactId: string;
  readonly planDigest: string;
  readonly inputDigest: string;
  readonly revision: number;
  readonly expiresAt: string;
  readonly title: string;
  readonly sourceCount: number;
  readonly coverage: "validated" | "partial";
  readonly fallbackText: string;
}

export interface GenerationStage {
  generate(input: { plan: UiPlan; ownerId: string; correlationId: string; signal: AbortSignal }): Promise<RegisteredView>;
}

export interface RenderStage {
  /** Resolves only on a valid, instance-bound ready handshake from the mounted surface. */
  awaitReady(input: { instanceId: string; timeoutMs: number; signal: AbortSignal }): Promise<boolean>;
  /** Tears down a surface that never became ready. */
  destroy(input: { instanceId: string; ownerId: string }): void;
}

/**
 * Everything the pipeline owns per execution: identity, correlation,
 * cancellation, progress, and exactly one terminal result. `emitView` hands
 * the renderer the opaque instance it should mount -- it is not the result,
 * and a view that never sends its ready handshake still fails the call.
 */
export interface UiGenerateContext {
  readonly correlationId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly signal: AbortSignal;
  emitProgress(state: UiGenerateProgressState): void;
  emitView(view: RegisteredView): void;
  trace?(event: string, detail: Record<string, unknown>): void;
}

export type { UiGenerateFailureCategory, UiGenerateResult };

/**
 * Internal, stage-scoped failure. Every stage throws one of these rather
 * than a bare error, so `pipeline.ts` can map any failure onto exactly one
 * closed `failed` category without ever inspecting a provider or page
 * string.
 */
export class UiGenerateStageError extends Error {
  override readonly name = "UiGenerateStageError";

  constructor(readonly category: UiGenerateFailureCategory, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
