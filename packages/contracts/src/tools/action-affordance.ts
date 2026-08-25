import { z } from "zod";
import { IdSchema } from "../primitives";

/**
 * The closed action-affordance contract (P03-F05 step 5): a bounded,
 * descriptive-only record of one interactive affordance a page exposed,
 * correlated -- conservatively -- with whatever the discovery pipeline
 * could actually observe about it.
 *
 * This is never itself a tool, and never carries anything executable: no
 * URL, method, header, cookie, selector, script, prompt, or policy
 * override appears anywhere in this shape. `targetClass`/
 * `requiredCapability` describe what a *later* phase would need in order
 * to ever act on this affordance -- Phase 3 cannot and does not act on
 * any of them.
 */

/** Bounded, closed set of what the affordance's label suggests it would do, if it were ever actionable. */
export const ActionAffordanceIntentSchema = z.enum([
  "purchase",
  "reserve",
  "submit_form",
  "delete",
  "authenticate",
  "subscribe",
  "unknown_mutation",
]);

export type ActionAffordanceIntent = z.infer<typeof ActionAffordanceIntentSchema>;

/**
 * What this affordance would be if a future phase ever executed it.
 * `unknown` is the conservative default (P03-F05 step 4): used whenever no
 * explicit provenance ties the affordance to an observed operation or a
 * stable navigation target. `live_website_handoff` is declared for
 * forward-compatibility with Phase 6 but is never produced by anything in
 * this phase -- no site-shape classifier exists yet.
 */
export const ActionAffordanceTargetClassSchema = z.enum([
  "local_ui",
  "read_only_operation",
  "external_workflow",
  "live_website_handoff",
  "unknown",
]);

export type ActionAffordanceTargetClass = z.infer<typeof ActionAffordanceTargetClassSchema>;

/** Which later-phase capability would be required before this affordance could ever be executed. */
export const ActionAffordanceRequiredCapabilitySchema = z.enum([
  "action_execution",
  "embedded_browser",
  "none",
]);

export type ActionAffordanceRequiredCapability = z.infer<
  typeof ActionAffordanceRequiredCapabilitySchema
>;

export const MAX_ACTION_AFFORDANCE_EVIDENCE = 5;

/**
 * One typed, opaque provenance reference -- never a raw request, selector,
 * or value. `operationId` (when present) is the same opaque handle
 * `invoke-discovered-api.ts`'s dynamic tool definitions use.
 */
export const ActionAffordanceEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dom_affordance"), affordanceId: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("observed_operation"), operationId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("stable_link_destination") }).strict(),
  z.object({ kind: z.literal("initiator_relationship"), operationId: z.string().min(1).max(128) }).strict(),
]);

export type ActionAffordanceEvidence = z.infer<typeof ActionAffordanceEvidenceSchema>;

export const OPAQUE_HANDLE_MAX_LENGTH = 128;
const OpaqueHandleSchema = z.string().min(1).max(OPAQUE_HANDLE_MAX_LENGTH);

export const ActionAffordanceSchema = z
  .object({
    actionId: IdSchema,
    intent: ActionAffordanceIntentSchema,
    siteId: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
    sourceHandle: OpaqueHandleSchema,
    listingHandle: OpaqueHandleSchema,
    itemHandle: OpaqueHandleSchema,
    targetClass: ActionAffordanceTargetClassSchema,
    evidence: z.array(ActionAffordanceEvidenceSchema).max(MAX_ACTION_AFFORDANCE_EVIDENCE),
    confidence: z.number().min(0).max(1),
    requiredCapability: ActionAffordanceRequiredCapabilitySchema,
  })
  .strict();

export type ActionAffordance = z.infer<typeof ActionAffordanceSchema>;
