import { z } from "zod";
import { OpaqueHandleSchema } from "./common";

/**
 * The closed relationship-edge union (P03-F02 step 3). Every edge shares
 * the same `{ kind, from, to, order? }` shape -- unlike node kinds, no
 * relationship kind needs extra fields, so this stays one schema rather
 * than a discriminated union.
 */
export const PageRelationshipKindSchema = z.enum([
  "parent_child",
  "reading_order",
  "label",
  "description",
  "control_target",
  "form_field",
  "form_submit",
  "table_header_cell",
  "list_item",
  "media_caption",
  "media_transcript",
  "record_field",
  "record_action",
  "record_source",
  "dialog_trigger",
  "tab_panel",
  "menu_item",
  "disclosure_content",
  "error_field",
  "pagination_collection",
  "visual_grouping",
]);

export type PageRelationshipKind = z.infer<typeof PageRelationshipKindSchema>;

export const PageRelationshipSchema = z
  .object({
    kind: PageRelationshipKindSchema,
    from: OpaqueHandleSchema,
    to: OpaqueHandleSchema,
    /** Ordinal position, when this edge kind is order-sensitive (e.g. `reading_order`, `list_item`); `null` otherwise. */
    order: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type PageRelationship = z.infer<typeof PageRelationshipSchema>;
