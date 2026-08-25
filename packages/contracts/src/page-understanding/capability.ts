import { z } from "zod";
import { ControlStateSchema, OpaqueHandleSchema } from "./common";
import { MAX_CAPABILITY_EVIDENCE, MAX_CAPABILITY_REQUIRED_INPUTS } from "./limits";

/**
 * Coarse effect classification (P03-F02 step 4): what kind of observable
 * effect activating this control would have, if it were ever activated.
 * Distinct from -- and coarser than -- `CapabilityKindSchema` below, which
 * is P03-F04's finer semantic/risk classification of the same control.
 */
export const EffectClassSchema = z.enum([
  "local_view",
  "navigation",
  "data_entry",
  "submission",
  "download",
  "media",
  "external_application",
  "unknown",
]);

export type EffectClass = z.infer<typeof EffectClassSchema>;

/**
 * P03-F04 step 1's closed semantic-capability/risk classification. Always
 * inferred from trusted DOM/accessibility facts (element type, form
 * ownership, role, destination) -- an untrusted page label may inform
 * display intent but can never raise or lower this classification (P03-F04
 * step 2).
 */
export const CapabilityKindSchema = z.enum([
  "local_view_change",
  "navigation",
  "data_entry",
  "form_submission",
  "account_authentication",
  "download_upload",
  "clipboard_share",
  "communication",
  "reservation_purchase_payment",
  "deletion_cancellation",
  "media_control",
  "external_application",
  "unknown",
]);

export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

/** Which later-phase capability would be required before this could ever be executed. Phase 3 never executes any of them. */
export const RequiredLaterCapabilitySchema = z.enum(["action_execution", "embedded_browser", "none"]);

export type RequiredLaterCapability = z.infer<typeof RequiredLaterCapabilitySchema>;

/**
 * One typed, opaque provenance reference for why a capability was
 * classified the way it was -- never a raw selector, script, or request.
 */
export const CapabilityEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dom_node"), nodeHandle: OpaqueHandleSchema }).strict(),
  z.object({ kind: z.literal("accessibility_state") }).strict(),
  z.object({ kind: z.literal("form_relationship"), formHandle: OpaqueHandleSchema }).strict(),
  z.object({ kind: z.literal("stable_link_destination") }).strict(),
]);

export type CapabilityEvidence = z.infer<typeof CapabilityEvidenceSchema>;

export const CAPABILITY_SEMANTIC_INTENT_MAX_LENGTH = 200;
export const CAPABILITY_DESTINATION_ORIGIN_MAX_LENGTH = 255;

/**
 * A bounded, descriptive-only record of one interactive control (P03-F02
 * step 4). This is never itself a tool and never carries anything
 * executable -- no URL for execution, method, header, cookie, selector,
 * script, or policy override appears anywhere in this shape. Describing a
 * capability never makes it executable (P03-F04 step 5); all handles stay
 * restricted to later policy/action phases.
 */
export const InteractionCapabilitySchema = z
  .object({
    capabilityId: OpaqueHandleSchema,
    semanticIntent: z.string().min(1).max(CAPABILITY_SEMANTIC_INTENT_MAX_LENGTH),
    controlHandle: OpaqueHandleSchema,
    /** The owning region/form/record handle, when this control belongs to one. */
    owningHandle: OpaqueHandleSchema.nullable(),
    capabilityKind: CapabilityKindSchema,
    state: ControlStateSchema,
    /** Names only (e.g. "email", "quantity") -- never a value the page or a prior fill supplied. */
    requiredInputs: z.array(z.string().min(1).max(100)).max(MAX_CAPABILITY_REQUIRED_INPUTS),
    /** Origin only (e.g. "https://example.com"), never a full URL with path/query. */
    destinationOrigin: z.string().max(CAPABILITY_DESTINATION_ORIGIN_MAX_LENGTH).nullable(),
    effectClass: EffectClassSchema,
    confidence: z.number().min(0).max(1),
    evidence: z.array(CapabilityEvidenceSchema).max(MAX_CAPABILITY_EVIDENCE),
    requiredCapability: RequiredLaterCapabilitySchema,
  })
  .strict();

export type InteractionCapability = z.infer<typeof InteractionCapabilitySchema>;
