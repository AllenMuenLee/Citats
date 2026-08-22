import { z } from "zod";
import { CorrelationMetadataSchema } from "./correlation";
import { SafeErrorMessageSchema, ToolErrorCodeSchema } from "./errors";
import { EvidenceListSchema } from "./evidence";
import { IdSchema } from "./primitives";
import { withCredentialGuard } from "./security/credential-guard";
import { SensitivityFlagsSchema } from "./sensitivity";
import { CONTRACT_MAJOR_VERSION } from "./version";
import { SystemEchoResultSchema } from "./tools/system-echo";

/**
 * Generic factory for a tool success result: correlation metadata echoed
 * back, the tool-specific structured payload, evidence/citations, and the
 * sensitivity flags for this particular result (a tool can be
 * sensitive-by-default per its definition, but the result is what carries
 * whether *this* invocation actually requires confirmation).
 */
export function makeToolSuccessResultSchema<Payload extends z.ZodTypeAny>(payloadSchema: Payload) {
  return withCredentialGuard(
    z
      .object({
        contractVersion: z.literal(CONTRACT_MAJOR_VERSION),
        correlation: CorrelationMetadataSchema,
        toolCallId: IdSchema,
        status: z.literal("success"),
        payload: payloadSchema,
        evidence: EvidenceListSchema.optional(),
        sensitivity: SensitivityFlagsSchema,
      })
      .strict(),
    (value) => (value as { payload: unknown }).payload,
    "payload",
  );
}

export const SystemEchoSuccessResultSchema = makeToolSuccessResultSchema(SystemEchoResultSchema);
export type SystemEchoSuccessResult = z.infer<typeof SystemEchoSuccessResultSchema>;

/**
 * Tool error result. `errorCode` is the closed set from `errors.ts`;
 * `message` is a safe, length-capped, non-leaking summary (never a raw
 * exception/stack trace -- see `SafeErrorMessageSchema`'s docstring).
 */
export const ToolErrorResultSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_MAJOR_VERSION),
    correlation: CorrelationMetadataSchema,
    toolCallId: IdSchema,
    status: z.literal("error"),
    errorCode: ToolErrorCodeSchema,
    message: SafeErrorMessageSchema,
    /** Whether the caller may reasonably retry this exact invocation as-is. */
    retryable: z.boolean(),
  })
  .strict();

export type ToolErrorResult = z.infer<typeof ToolErrorResultSchema>;
