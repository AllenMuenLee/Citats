import { z } from "zod";
import { HttpUrlSchema, IsoDateTimeSchema } from "../primitives";
import { OpaqueHandleSchema } from "./common";
import { UiSourceFieldRoleSchema } from "./source-candidate";

/**
 * `GenerativeUiPlan` (P03-F05 step 6): DISPLAY INTENT, never executable UI
 * code. The chat model proposes one of these (via the `ui.propose_generative_ui_plan`
 * tool, see `../tools/propose-generative-ui-plan.ts`) instead of emitting
 * React/HTML/CSS/JavaScript, a raw API, a selector, or a URL for execution.
 * Every handle referenced here must belong to the same `observationId` this
 * plan is validated against server-side (P03-F05 step 4's ownership check)
 * -- see `services/browser/src/browser_service/tools/propose_generative_ui_plan.py`.
 *
 * Phase 3 does not render this plan: no presentation-primitive registry
 * exists yet (that is Phase 4's job). Server-side validation here always
 * falls back to cited text, per P03-F02 step 6's "fall back to cited text
 * or a generic collection when no registered component can satisfy it".
 */
export const GenerativeUiLayoutKindSchema = z.enum([
  "list",
  "grid",
  "card_grid",
  "table",
  "comparison",
  "gallery",
  "timeline",
  "map",
  "detail",
  "generic_collection",
  "cited_text",
]);

export type GenerativeUiLayoutKind = z.infer<typeof GenerativeUiLayoutKindSchema>;

export const GenerativeUiFilterOperatorSchema = z.enum(["equals", "contains", "range", "exists"]);

export const GenerativeUiFilterSchema = z
  .object({
    field: UiSourceFieldRoleSchema,
    operator: GenerativeUiFilterOperatorSchema,
    value: z.string().max(200).nullable(),
  })
  .strict();

export type GenerativeUiFilter = z.infer<typeof GenerativeUiFilterSchema>;

export const GenerativeUiOrderBySchema = z
  .object({
    field: UiSourceFieldRoleSchema,
    direction: z.enum(["asc", "desc"]),
  })
  .strict();

export const GenerativeUiMediaPlacementSchema = z.enum(["leading", "trailing", "background", "none"]);

export const GenerativeUiFreshnessSchema = z.enum(["live", "cached", "unknown"]);

export const GenerativeUiProvenanceSchema = z
  .object({
    sourceUrl: HttpUrlSchema,
    retrievedAt: IsoDateTimeSchema,
  })
  .strict();

export const MAX_GENERATIVE_UI_SOURCE_COLLECTIONS = 10;
export const MAX_GENERATIVE_UI_SELECTED_FIELDS = 24;
export const MAX_GENERATIVE_UI_FILTERS = 10;
export const MAX_GENERATIVE_UI_DETAIL_REGIONS = 5;
export const MAX_GENERATIVE_UI_WARNINGS = 10;
export const MAX_GENERATIVE_UI_INTENTS = 10;

export const GenerativeUiPlanSchema = z
  .object({
    observationId: OpaqueHandleSchema,
    layoutKind: GenerativeUiLayoutKindSchema,
    sourceCollectionHandles: z.array(OpaqueHandleSchema).max(MAX_GENERATIVE_UI_SOURCE_COLLECTIONS),
    selectedFields: z.array(UiSourceFieldRoleSchema).max(MAX_GENERATIVE_UI_SELECTED_FIELDS),
    groupBy: UiSourceFieldRoleSchema.nullable(),
    orderBy: GenerativeUiOrderBySchema.nullable(),
    filters: z.array(GenerativeUiFilterSchema).max(MAX_GENERATIVE_UI_FILTERS),
    detailRegionHandles: z.array(OpaqueHandleSchema).max(MAX_GENERATIVE_UI_DETAIL_REGIONS),
    mediaPlacement: GenerativeUiMediaPlacementSchema,
    provenance: GenerativeUiProvenanceSchema,
    freshness: GenerativeUiFreshnessSchema,
    warnings: z.array(z.string().max(300)).max(MAX_GENERATIVE_UI_WARNINGS),
    /** `InteractionCapability` ids classified `local_view_change` only -- e.g. a tab/filter switch this plan's own view can safely reflect. */
    localInteractionIntents: z.array(OpaqueHandleSchema).max(MAX_GENERATIVE_UI_INTENTS),
    /** `InteractionCapability` ids that would need a later phase (action execution, embedded browser) to ever run. Never executed here. */
    externalWorkflowIntents: z.array(OpaqueHandleSchema).max(MAX_GENERATIVE_UI_INTENTS),
  })
  .strict();

export type GenerativeUiPlan = z.infer<typeof GenerativeUiPlanSchema>;
