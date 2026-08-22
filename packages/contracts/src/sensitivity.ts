import { z } from "zod";

/**
 * Closed set of reasons an action can be flagged as sensitive. `other` is
 * the deliberate escape hatch for a reason not yet enumerated -- adding a
 * *new named* reason is a non-breaking (additive) change to this enum
 * under the versioning rule in `version.ts`; but note that unlike an
 * object field, adding an enum member DOES change what a strict
 * `z.enum([...])` on the reading side will accept, so both sides must
 * still ship the updated enum together even though it is not a major
 * version bump.
 */
export const SensitivityReasonSchema = z.enum([
  "payment",
  "account_change",
  "irreversible_submission",
  "other",
]);

export const MAX_SENSITIVITY_REASONS = 8;

/**
 * Sensitivity flags threaded through tool definitions and results: whether
 * the action is sensitive, why, and whether explicit user confirmation is
 * required before/because of it.
 */
export const SensitivityFlagsSchema = z
  .object({
    sensitive: z.boolean(),
    reasons: z.array(SensitivityReasonSchema).max(MAX_SENSITIVITY_REASONS).optional(),
    confirmationRequired: z.boolean(),
  })
  .strict();

export type SensitivityFlags = z.infer<typeof SensitivityFlagsSchema>;
