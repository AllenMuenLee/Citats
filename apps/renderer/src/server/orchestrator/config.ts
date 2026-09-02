import "server-only";

import { z } from "zod";

/**
 * `maxSteps` is a runaway-loop backstop only. A turn is now at most one
 * `ui.generate` call followed by the answer that reports it, so the default
 * is small; it exists to end a turn where the model keeps producing calls
 * without ever answering, not to cap legitimate work.
 *
 * There is deliberately no time-based deadline here: a turn ends when the
 * model finishes, this step cap is hit, or the user stops it themselves
 * (see the Stop control wired through to the request's own AbortSignal in
 * `ChatOrchestrator.run`).
 */
const OrchestratorConfigSchema = z.object({
  maxSteps: z.coerce.number().int().min(1).max(50),
  /** How much prior-turn history one request may re-send. */
  maxContextTokens: z.coerce.number().int().min(500).max(200_000),
  /** Logs each model call's reported prompt/completion tokens, for tuning the budget above against a real rate limit. */
  logTokenUsage: z.boolean(),
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export function readOrchestratorConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OrchestratorConfig {
  const parsed = OrchestratorConfigSchema.safeParse({
    maxSteps: environment.CHAT_MAX_STEPS ?? "3",
    maxContextTokens: environment.CHAT_MAX_CONTEXT_TOKENS ?? "16000",
    logTokenUsage: environment.CHAT_LOG_TOKEN_USAGE === "1",
  });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]).filter(Boolean))];
    throw new Error(`Orchestrator configuration is invalid (${fields.join(", ")}).`);
  }
  return parsed.data;
}
