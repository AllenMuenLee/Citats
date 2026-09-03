import "server-only";

import {
  UI_GENERATE_ARGS_JSON_SCHEMA,
  UI_GENERATE_TOOL_NAME,
  UiGenerateResultSchema,
  UiGenerateToolDefinition,
  uiGenerateFailure,
  type UiGenerateResult,
} from "@ai-browser/contracts";
import type { ModelToolDefinition } from "../ai";

/**
 * The conversation model's entire tool surface (P02-F02 step 1).
 *
 * There is one entry, `ui.generate`, and there is no path by which another
 * one can be added at runtime: the registry takes a pipeline, not a list.
 * The browsing, exploration, and page-slice tools that used to live here
 * are gone -- every stage they served is now fixed trusted code behind this
 * one call.
 */
export interface RegisteredTool {
  readonly definition: ModelToolDefinition;
  readonly sensitive: false;
  parseArguments(value: unknown): unknown;
  execute(args: unknown, context: ToolExecutionContext): Promise<UiGenerateResult>;
}

export interface ToolExecutionContext {
  requestId: string;
  userId: string;
  sessionId: string;
  invocationId: string;
  signal: AbortSignal;
  /** The verbatim text of the turn being answered. `ui.generate` is executed against this, not against what the model typed. */
  requestText: string;
  emitProgress(state: string): void;
  emitView(view: unknown): void;
  trace?(event: string, detail: Record<string, unknown>): void;
}

/** What the registry needs from the pipeline, without importing its whole module graph. */
export type UiGenerateExecutor = (
  request: string,
  context: {
    correlationId: string;
    ownerId: string;
    sessionId: string;
    invocationId: string;
    signal: AbortSignal;
    emitProgress(state: never): void;
    emitView(view: never): void;
    trace?(event: string, detail: Record<string, unknown>): void;
  },
) => Promise<UiGenerateResult>;

/**
 * Builds the single-tool registry. Passing no executor yields an empty
 * registry: the turn then has no tools at all and the model simply answers,
 * which is the correct behaviour for an installation without the internal
 * models configured.
 */
export function createToolRegistry(options: { uiGenerate?: UiGenerateExecutor }): ReadonlyMap<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  if (!options.uiGenerate) return tools;
  const uiGenerate = options.uiGenerate;
  tools.set(UI_GENERATE_TOOL_NAME, {
    definition: {
      name: UI_GENERATE_TOOL_NAME,
      description: UiGenerateToolDefinition.description,
      strict: true,
      parameters: UI_GENERATE_ARGS_JSON_SCHEMA as unknown as Record<string, unknown>,
    },
    sensitive: false,
    // `ui.generate` has no arguments. Whatever the model emits alongside the
    // call is discarded -- the pipeline always runs against `requestText`.
    parseArguments: () => ({}),
    async execute(_args, context) {
      // The pipeline runs against the turn's own text, never against
      // anything the model produced, so a model that tries to attach a
      // paraphrased or substituted request cannot steer source finding.
      const result = await uiGenerate(context.requestText, {
        correlationId: context.requestId,
        ownerId: context.userId,
        sessionId: context.sessionId,
        invocationId: context.invocationId,
        signal: context.signal,
        emitProgress: context.emitProgress as (state: never) => void,
        emitView: context.emitView as (view: never) => void,
        ...(context.trace ? { trace: context.trace } : {}),
      }).catch((error: unknown) => {
        if (context.signal.aborted) return uiGenerateFailure("cancelled");
        console.error("[ui.generate] execution failed", error);
        return uiGenerateFailure("internal");
      });
      // The result union is re-validated on the way back, so only a closed,
      // safe shape is ever appended to model context.
      return UiGenerateResultSchema.parse(result);
    },
  });
  return tools;
}
