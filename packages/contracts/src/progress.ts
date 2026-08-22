import { z } from "zod";
import { CorrelationMetadataSchema } from "./correlation";
import { IdSchema } from "./primitives";
import { withCredentialGuard } from "./security/credential-guard";
import { CONTRACT_MAJOR_VERSION } from "./version";
import { SystemEchoResultSchema } from "./tools/system-echo";

export const PROGRESS_MESSAGE_MAX_LENGTH = 500;

/** Closed set of progress phases a streamed tool-call update can report. */
export const ToolProgressPhaseSchema = z.enum([
  "queued",
  "started",
  "in_progress",
  "awaiting_confirmation",
  "finalizing",
]);

export type ToolProgressPhase = z.infer<typeof ToolProgressPhaseSchema>;

/**
 * Generic factory for a streamed progress/event update (SSE payload per
 * ADR 0003): correlation metadata, the current phase, an optional
 * human-readable message, and an optional partial version of the tool's
 * eventual result payload (e.g. partial extracted text while a page is
 * still loading).
 */
export function makeToolProgressEventSchema<Payload extends z.ZodTypeAny>(partialPayloadSchema: Payload) {
  return withCredentialGuard(
    z
      .object({
        contractVersion: z.literal(CONTRACT_MAJOR_VERSION),
        correlation: CorrelationMetadataSchema,
        toolCallId: IdSchema,
        phase: ToolProgressPhaseSchema,
        message: z.string().max(PROGRESS_MESSAGE_MAX_LENGTH).optional(),
        partialPayload: partialPayloadSchema.optional(),
      })
      .strict(),
    (value) => (value as { partialPayload: unknown }).partialPayload,
    "partialPayload",
  );
}

export const SystemEchoProgressEventSchema = makeToolProgressEventSchema(
  SystemEchoResultSchema.partial().strict(),
);
export type SystemEchoProgressEvent = z.infer<typeof SystemEchoProgressEventSchema>;
