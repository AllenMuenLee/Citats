/**
 * The opaque instance the renderer is handed so it can mount a generated
 * view. It carries no HTML, no TSX, no implementation prompt, and no URL --
 * the artifact is fetched from the app's own origin by id, and the display
 * props are the trusted source projection the instance store already
 * validated.
 */
export interface GeneratedViewEvent {
  type: "generated-ui";
  id: string;
  view: {
    instanceId: string;
    artifactId: string;
    implementationPromptDigest: string;
    inputDigest: string;
    revision: number;
    expiresAt: string;
    title: string;
    sourceCount: number;
    coverage: "validated" | "partial";
    fallbackText: string;
  };
}

export type OrchestratorEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-status"; id: string; label: string; state: "running" | "completed" | "failed"; response?: string; reason?: string }
  /** A bounded `ui.generate` stage transition. Never carries HTML, a plan, TSX, a prompt, or compiler state. */
  | { type: "tool-progress"; id: string; toolCallId: string; state: string; label: string }
  | GeneratedViewEvent
  | { type: "error"; message: string; retryable: boolean }
  | { type: "done" };

export type OrchestratorState =
  | "model-request"
  | "tool-validation"
  | "tool-execution"
  | "result-append"
  | "final-response"
  | "completed";

export class OrchestratorError extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_TOOL"
      | "REPEATED_TOOL_CALL"
      | "STEP_LIMIT"
      | "DEADLINE"
      | "CANCELLED"
      | "CONTRACT_ERROR"
      /** Consecutive steps came back with neither a tool call nor any user-visible text. Retryable. */
      | "EMPTY_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}
