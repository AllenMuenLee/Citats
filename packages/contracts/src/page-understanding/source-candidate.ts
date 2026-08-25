import { z } from "zod";
import { OpaqueHandleSchema } from "./common";
import { MAX_COLLECTION_RECORD_HANDLES, MAX_SOURCE_CANDIDATE_FIELDS } from "./limits";

/** What kind of repeated collection a `RepeatedCollection` groups (mission item 4). */
export const RepeatedCollectionRoleSchema = z.enum([
  "search_results",
  "product_listing",
  "flight_schedule",
  "news_feed",
  "media_gallery",
  "comparison_group",
  "timeline",
  "calendar",
  "generic_records",
]);

export type RepeatedCollectionRole = z.infer<typeof RepeatedCollectionRoleSchema>;

/** A bounded, repeated group of `repeated_record` nodes (e.g. a search-results list, a product grid). */
export const RepeatedCollectionSchema = z
  .object({
    handle: OpaqueHandleSchema,
    role: RepeatedCollectionRoleSchema,
    itemCount: z.number().int().nonnegative(),
    recordHandles: z.array(OpaqueHandleSchema).max(MAX_COLLECTION_RECORD_HANDLES),
    truncated: z.boolean(),
    paginationHandle: OpaqueHandleSchema.nullable(),
  })
  .strict();

export type RepeatedCollection = z.infer<typeof RepeatedCollectionSchema>;

/**
 * Closed set of generic-UI field roles (P03-F02 step 5): what a later
 * generative-UI phase would need to identify inside a repeated record
 * without a hard-coded site schema.
 */
export const UiSourceFieldRoleSchema = z.enum([
  "title",
  "description",
  "image",
  "audio",
  "video",
  "price",
  "rating",
  "date",
  "amenity",
  "availability",
  "provider",
  "action",
]);

export type UiSourceFieldRole = z.infer<typeof UiSourceFieldRoleSchema>;

export const UiSourceFieldMappingSchema = z
  .object({
    role: UiSourceFieldRoleSchema,
    nodeHandle: OpaqueHandleSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type UiSourceFieldMapping = z.infer<typeof UiSourceFieldMappingSchema>;

/**
 * Maps one collection (or one record within it) to the generic field roles
 * a later generative-UI phase could bind to -- title/description/image/
 * price/etc -- plus which `InteractionCapability`s (never raw actions)
 * are associated with it. Original evidence/uncertainty is preserved via
 * per-field `confidence`; a missing value is never guessed (P03-F02 step 5).
 */
export const UiSourceCandidateSchema = z
  .object({
    collectionHandle: OpaqueHandleSchema,
    /** `null` when this candidate describes the collection as a whole rather than one record within it. */
    recordHandle: OpaqueHandleSchema.nullable(),
    fields: z.array(UiSourceFieldMappingSchema).max(MAX_SOURCE_CANDIDATE_FIELDS),
    actionCapabilityIds: z.array(OpaqueHandleSchema).max(10),
  })
  .strict();

export type UiSourceCandidate = z.infer<typeof UiSourceCandidateSchema>;
