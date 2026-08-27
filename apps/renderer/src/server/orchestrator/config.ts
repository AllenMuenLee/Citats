import "server-only";

import { z } from "zod";

/**
 * `maxSteps` is a runaway-loop backstop only -- it exists to end a turn
 * where the model keeps issuing tool calls without ever producing a final
 * answer, not to cap how long a legitimate multi-step turn (web search,
 * several real browser.explore_website / navigate_and_extract calls, then
 * ui.propose_generative_ui_plan and UI generation) is allowed to take.
 * There is deliberately no time-based deadline here: a turn ends when the
 * model finishes, this step cap is hit, or the user stops it themselves
 * (see the Stop control wired through to the request's own AbortSignal in
 * `ChatOrchestrator.run` -- `apps/renderer/src/server/orchestrator/orchestrator.ts`).
 */
const OrchestratorConfigSchema = z.object({
  maxSteps: z.coerce.number().int().min(1).max(50),
  /** How much prior-turn history one request may re-send. */
  maxContextTokens: z.coerce.number().int().min(500).max(200_000),
  /**
   * Opt-in ceiling on what one in-flight turn's own tool loop may accumulate.
   * Unset by default: nothing a turn produced is ever elided, so a long
   * multi-page turn keeps every result it gathered. Tool results are already
   * projected down to their model-relevant fields before any of this counts
   * (see `model-view.ts`), which is what actually reduces the per-request
   * cost; this only exists as a backstop for an account whose rate limit is
   * tight enough to need one.
   */
  maxRunTokens: z.coerce.number().int().min(500).max(200_000).optional(),
  /** Logs each model call's reported prompt/completion tokens, for tuning the budgets above against a real rate limit. */
  logTokenUsage: z.boolean(),
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export function readOrchestratorConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OrchestratorConfig {
  const parsed = OrchestratorConfigSchema.safeParse({
    maxSteps: environment.CHAT_MAX_STEPS ?? "25",
    maxContextTokens: environment.CHAT_MAX_CONTEXT_TOKENS ?? "16000",
    maxRunTokens: environment.CHAT_MAX_RUN_TOKENS,
    logTokenUsage: environment.CHAT_LOG_TOKEN_USAGE === "1",
  });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]).filter(Boolean))];
    throw new Error(`Orchestrator configuration is invalid (${fields.join(", ")}).`);
  }
  return parsed.data;
}
