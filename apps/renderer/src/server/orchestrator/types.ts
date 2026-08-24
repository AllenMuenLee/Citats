/** A resolved source cited somewhere in the completed answer (see `apps/renderer/src/server/citations/`). */
export interface OrchestratorCitationSource {
  id: string;
  url: string;
  title: string;
  retrievedAt: string;
}

export type OrchestratorEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-status"; id: string; label: string; state: "running" | "completed" | "failed" }
  | { type: "artifact"; id: string; artifactType: "image" | "file" | "source"; title: string; url?: string; mediaType?: string }
  | { type: "error"; message: string; retryable: boolean }
  /**
   * Inline reference tying a position in the streamed assistant text to a
   * citation that has already been resolved (validated) against the
   * evidence for this turn -- an unresolved/invalid citation must never be
   * emitted as a marker. `position` is the number of assistant-text
   * characters emitted (via `text-delta`) before this marker; `id` is a
   * unique id for this marker instance (for de-duplication), distinct from
   * `citationId` (the resolved `Citation.id`, which may be marked more
   * than once if the same source is cited at multiple positions).
   */
  | { type: "citation-marker"; id: string; citationId: string; sourceId: string; position: number }
  /** The deduplicated list of sources actually cited in the completed answer. */
  | { type: "citation-sources"; id: string; sources: OrchestratorCitationSource[] }
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
      /** The trusted routing decision (P02-F05) could not be produced or was malformed; failed closed before any tool was exposed. Retryable -- never a policy violation by the model. */
      | "ROUTING_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}
