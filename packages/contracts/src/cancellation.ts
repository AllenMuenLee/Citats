import { z } from "zod";
import { CorrelationMetadataSchema } from "./correlation";
import { CONTRACT_MAJOR_VERSION } from "./version";

export const CANCELLATION_REASON_MAX_LENGTH = 300;

/**
 * A request to cancel an in-flight task (`DELETE /v1/tasks/{task_id}` per
 * `docs/architecture/system.md` flow (c)). `correlation.taskId` identifies
 * the task to cancel and MUST be present -- enforced below with a
 * cross-field check beyond what `CorrelationMetadataSchema` alone requires
 * (that schema treats `taskId` as generally optional since it is absent in
 * other message types before a task exists).
 */
export const CancellationRequestSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_MAJOR_VERSION),
    correlation: CorrelationMetadataSchema,
    reason: z.string().max(CANCELLATION_REASON_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.correlation.taskId) {
      ctx.addIssue({
        code: "custom",
        message: "correlation.taskId is required for a cancellation request",
        path: ["correlation", "taskId"],
      });
    }
  });

export type CancellationRequest = z.infer<typeof CancellationRequestSchema>;

/** Closed set of outcomes a cancellation can resolve to. */
export const CancellationStatusSchema = z.enum([
  "cancelled",
  "not_cancellable",
  "already_completed",
]);

export type CancellationStatus = z.infer<typeof CancellationStatusSchema>;

/** Acknowledgement/result of a cancellation request. */
export const CancellationResultSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_MAJOR_VERSION),
    correlation: CorrelationMetadataSchema,
    status: CancellationStatusSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.correlation.taskId) {
      ctx.addIssue({
        code: "custom",
        message: "correlation.taskId is required for a cancellation result",
        path: ["correlation", "taskId"],
      });
    }
  });

export type CancellationResult = z.infer<typeof CancellationResultSchema>;
