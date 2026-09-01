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

/**
 * How the Phase 4 generated component is allowed to run this interaction
 * (P03-F02 step 4):
 *
 * - `internal_react` -- sorting, filtering, selection, expansion, tabs,
 *   galleries and anything else that only reorders or reveals data the
 *   component was already given. It executes entirely inside the generated
 *   React component and never reaches the host, the server, the model, or
 *   the website.
 * - `external_ai_action` -- an intent that would affect the real website
 *   (navigate, refresh, search, book, buy, submit). The generated
 *   component may only emit the opaque `capabilityId` plus this
 *   capability's `promptTemplateId` and schema-valid bounded arguments;
 *   the trusted server reconstructs the actual AI action prompt from
 *   `promptTemplate` before any later-phase browser action.
 */
export const InteractionExecutionSchema = z.enum(["internal_react", "external_ai_action"]);

export type InteractionExecution = z.infer<typeof InteractionExecutionSchema>;

export const CAPABILITY_ARGUMENT_NAME_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
export const MAX_CAPABILITY_ARGUMENTS = 12;
export const MAX_CAPABILITY_ARGUMENT_ENUM_VALUES = 24;

/**
 * One allowlisted argument an external capability accepts. Names only, plus
 * a coarse type and an optional closed value set -- never a page value, a
 * default sourced from the page, or anything a credential/payment field
 * could travel in.
 */
export const CapabilityArgumentSchema = z
  .object({
    name: z.string().min(1).max(60).regex(CAPABILITY_ARGUMENT_NAME_PATTERN),
    type: z.enum(["string", "number", "boolean", "enum"]),
    required: z.boolean(),
    /** Present only for `type: "enum"`; a closed set of display-safe values. */
    values: z.array(z.string().min(1).max(120)).max(MAX_CAPABILITY_ARGUMENT_ENUM_VALUES).nullable(),
  })
  .strict()
  .superRefine((argument, ctx) => {
    if ((argument.type === "enum") !== (argument.values !== null)) {
      ctx.addIssue({ code: "custom", path: ["values"], message: "values must be present exactly for enum arguments" });
    }
  });

export type CapabilityArgument = z.infer<typeof CapabilityArgumentSchema>;

export const CAPABILITY_PROMPT_TEMPLATE_MAX_LENGTH = 600;

/**
 * Patterns a model-authored intent template must never contain. The
 * template is untrusted text: it describes what the user wants done in
 * words, and the later action phase -- not this string -- decides what may
 * actually run. Anything that looks like a selector, an executable URL, a
 * tool name, a credential, or a policy grant is rejected outright rather
 * than sanitized, because a partially-cleaned instruction is worse than a
 * refused one.
 */
const FORBIDDEN_TEMPLATE_PATTERNS: readonly RegExp[] = [
  /\b[a-z]+:\/\//i,
  /<[^>]+>/,
  /(^|[\s(])[.#][a-z][\w-]*/i,
  /\bdocument\s*\.|\bwindow\s*\.|querySelector|xpath/i,
  /\bbrowser\.[a-z_]+|\btool\s*[:=]|\bfunction_call\b/i,
  /\b(password|passwd|secret|api[_-]?key|token|cookie|authorization|cvv|card\s*number)\b/i,
  /\b(ignore|disregard|override)\b[^.]{0,40}\b(instruction|policy|rule|confirmation)/i,
];

/**
 * A bounded, human-readable description of the action a user activating an
 * external control is asking for. `{{argumentName}}` placeholders are
 * filled in server-side from schema-validated arguments -- the generated
 * component never sees or supplies this text.
 */
export const CapabilityPromptTemplateSchema = z
  .string()
  .min(1)
  .max(CAPABILITY_PROMPT_TEMPLATE_MAX_LENGTH)
  .refine(
    (value) => !FORBIDDEN_TEMPLATE_PATTERNS.some((pattern) => pattern.test(value)),
    "prompt template must not contain a selector, URL, tool name, secret, or policy override",
  );

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
    interactionExecution: InteractionExecutionSchema,
    /**
     * The trusted server-held prompt template this capability resolves to,
     * set only for `external_ai_action`. Opaque to the generated component,
     * which can reference it but never read or author it.
     */
    promptTemplateId: OpaqueHandleSchema.nullable(),
    /** Untrusted, model-authored intent text; see `CapabilityPromptTemplateSchema`. */
    promptTemplate: CapabilityPromptTemplateSchema.nullable(),
    argumentSchema: z.array(CapabilityArgumentSchema).max(MAX_CAPABILITY_ARGUMENTS),
    confidence: z.number().min(0).max(1),
    evidence: z.array(CapabilityEvidenceSchema).max(MAX_CAPABILITY_EVIDENCE),
    requiredCapability: RequiredLaterCapabilitySchema,
  })
  .strict()
  .superRefine((capability, ctx) => {
    const external = capability.interactionExecution === "external_ai_action";
    if (external !== (capability.promptTemplateId !== null) || external !== (capability.promptTemplate !== null)) {
      ctx.addIssue({ code: "custom", path: ["promptTemplateId"], message: "a prompt template is required exactly for external_ai_action capabilities" });
    }
    if (!external && capability.argumentSchema.length > 0) {
      ctx.addIssue({ code: "custom", path: ["argumentSchema"], message: "internal_react capabilities take no arguments" });
    }
    if (new Set(capability.argumentSchema.map((argument) => argument.name)).size !== capability.argumentSchema.length) {
      ctx.addIssue({ code: "custom", path: ["argumentSchema"], message: "argument names must be unique" });
    }
    const declared = new Set(capability.argumentSchema.map((argument) => argument.name));
    for (const placeholder of capability.promptTemplate?.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) ?? []) {
      if (!declared.has(placeholder[1]!)) {
        ctx.addIssue({ code: "custom", path: ["promptTemplate"], message: `prompt template references undeclared argument ${placeholder[1]}` });
      }
    }
  });

export type InteractionCapability = z.infer<typeof InteractionCapabilitySchema>;
