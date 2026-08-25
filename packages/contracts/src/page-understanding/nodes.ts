import { z } from "zod";
import { HttpUrlSchema } from "../primitives";
import { BoundingBoxSchema, ControlStateSchema, OpaqueHandleSchema, VisibilityStateSchema } from "./common";
import { PAGE_NODE_LABEL_MAX_LENGTH, PAGE_NODE_TEXT_MAX_LENGTH } from "./limits";

/**
 * The closed node union (P03-F02 step 2): every element the page-observation
 * adapter (P03-F01) can describe is exactly one of these 21 kinds. Each
 * kind's own `role`-style sub-enum carries the HTML/ARIA specialization the
 * mission's "Required page coverage" list calls for, rather than growing
 * the top-level `kind` union further -- e.g. "price"/"rating"/"badge" are
 * `text` nodes with `role: "price"`, not their own node kinds.
 *
 * No node kind anywhere in this union carries a selector, DOM path, script,
 * raw attribute bag, computed-style dump, or field *value* -- only the
 * bounded, typed, descriptive facts the mission enumerates.
 */

const LabelSchema = z.string().trim().min(1).max(PAGE_NODE_LABEL_MAX_LENGTH).nullable();
const TextSchema = z.string().max(PAGE_NODE_TEXT_MAX_LENGTH);

const NodeBaseSchema = z.object({
  handle: OpaqueHandleSchema,
  boundingBox: BoundingBoxSchema.nullable(),
  visibility: VisibilityStateSchema,
});

export const MetadataNodePurposeSchema = z.enum(["open_graph", "twitter_card", "json_ld", "other"]);

export const MetadataNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("metadata"),
  purpose: MetadataNodePurposeSchema,
  title: LabelSchema,
  description: z.string().max(PAGE_NODE_TEXT_MAX_LENGTH).nullable(),
  url: HttpUrlSchema.nullable(),
}).strict();

export const LandmarkRoleSchema = z.enum([
  "document",
  "main",
  "header",
  "footer",
  "navigation",
  "search",
  "article",
  "section",
  "aside",
  "complementary",
  "region",
  "banner",
  "contentinfo",
  "form",
]);

export const LandmarkNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("landmark"),
  role: LandmarkRoleSchema,
  label: LabelSchema,
}).strict();

export const TextNodeRoleSchema = z.enum([
  "paragraph",
  "span",
  "label",
  "heading",
  "quote",
  "citation",
  "code",
  "keyboard_input",
  "definition",
  "abbreviation",
  "address",
  "time",
  "line_break",
  "footnote",
  "breadcrumb_item",
  "badge",
  "tag",
  "price",
  "rating",
  "availability",
  "status",
  "figure_caption",
  "separator",
]);

export const TextNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("text"),
  role: TextNodeRoleSchema,
  text: TextSchema,
  headingLevel: z.number().int().min(1).max(6).nullable(),
}).strict();

export const TextEmphasisSchema = z.enum([
  "strong",
  "emphasis",
  "inserted",
  "deleted",
  "marked",
  "superscript",
  "subscript",
]);

export const RichTextNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("rich_text"),
  text: TextSchema,
  emphasis: z.array(TextEmphasisSchema).max(6),
}).strict();

export const ListRoleSchema = z.enum([
  "list",
  "description_list",
  "breadcrumb_list",
  "tab_list",
  "menu",
  "toolbar",
  "tree",
]);

export const ListNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("list"),
  role: ListRoleSchema,
  ordered: z.boolean().nullable(),
  itemCount: z.number().int().nonnegative(),
  nested: z.boolean(),
  truncated: z.boolean(),
}).strict();

export const TableRoleSchema = z.enum(["table", "grid", "tree_grid"]);

export const TableNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("table"),
  role: TableRoleSchema,
  caption: LabelSchema,
  rowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();

export const RepeatedRecordRoleSchema = z.enum([
  "search_result",
  "product_card",
  "listing",
  "feed_item",
  "timeline_entry",
  "calendar_entry",
  "schedule_entry",
  "comparison_item",
  "generic_record",
]);

export const RepeatedRecordNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("repeated_record"),
  role: RepeatedRecordRoleSchema,
  collectionHandle: OpaqueHandleSchema,
  index: z.number().int().nonnegative(),
}).strict();

export const ImageRoleSchema = z.enum([
  "photo",
  "icon",
  "logo",
  "avatar",
  "thumbnail",
  "poster",
  "map_image",
  "background_image",
]);

export const ImageNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("image"),
  role: ImageRoleSchema,
  altText: LabelSchema,
  source: HttpUrlSchema.nullable(),
  intrinsicWidth: z.number().int().positive().nullable(),
  intrinsicHeight: z.number().int().positive().nullable(),
}).strict();

export const SvgChartRoleSchema = z.enum(["chart", "diagram", "map", "icon", "illustration"]);

export const SvgChartNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("svg_chart"),
  role: SvgChartRoleSchema,
  label: LabelSchema,
}).strict();

export const CanvasRegionNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("canvas_region"),
  label: LabelSchema,
  description: z.string().max(PAGE_NODE_TEXT_MAX_LENGTH).nullable(),
}).strict();

export const MediaPlaybackStateSchema = z.enum(["playing", "paused", "unknown"]);

export const AudioNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("audio"),
  title: LabelSchema,
  hasControls: z.boolean(),
  durationSeconds: z.number().nonnegative().nullable(),
  currentTimeSeconds: z.number().nonnegative().nullable(),
  playbackState: MediaPlaybackStateSchema,
  hasCaptions: z.boolean(),
}).strict();

export const VideoNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("video"),
  title: LabelSchema,
  hasControls: z.boolean(),
  durationSeconds: z.number().nonnegative().nullable(),
  currentTimeSeconds: z.number().nonnegative().nullable(),
  playbackState: MediaPlaybackStateSchema,
  hasCaptions: z.boolean(),
  posterSource: HttpUrlSchema.nullable(),
}).strict();

export const LinkDestinationClassSchema = z.enum([
  "same_page",
  "same_origin",
  "external_origin",
  "download",
  "mailto",
  "tel",
  "unsafe",
]);

export const LinkNodeRoleSchema = z.enum(["link", "tab", "breadcrumb", "pagination"]);

export const LinkNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("link"),
  role: LinkNodeRoleSchema,
  label: LabelSchema,
  destination: HttpUrlSchema.nullable(),
  destinationClass: LinkDestinationClassSchema,
}).strict();

export const ControlRoleSchema = z.enum([
  "button",
  "icon_button",
  "menu_button",
  "toggle",
  "disclosure",
  "tab",
  "accordion_trigger",
  "carousel_control",
  "stepper",
  "split_button",
  "toolbar_control",
  "tree_control",
  "context_menu_trigger",
  "popup_trigger",
  "command_palette_trigger",
  "copy_control",
  "share_control",
  "print_control",
  "media_control",
  "custom_widget",
]);

export const ControlNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("control"),
  role: ControlRoleSchema,
  label: LabelSchema,
  state: ControlStateSchema,
}).strict();

export const FormMethodClassSchema = z.enum(["safe", "unsafe", "unknown"]);

export const FormNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("form"),
  label: LabelSchema,
  methodClass: FormMethodClassSchema,
}).strict();

export const FieldRoleSchema = z.enum([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "password",
  "date",
  "time",
  "month",
  "week",
  "number",
  "range",
  "color",
  "file",
  "hidden",
  "textarea",
  "select",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "datalist",
]);

/** Never carries a field *value* -- structural descriptor only (mission item 9). */
export const FieldNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("field"),
  role: FieldRoleSchema,
  label: LabelSchema,
  required: z.boolean(),
  disabled: z.boolean(),
  readOnly: z.boolean(),
}).strict();

export const OptionNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("option"),
  label: LabelSchema,
  selected: z.boolean(),
  disabled: z.boolean(),
}).strict();

export const DialogRoleSchema = z.enum([
  "dialog",
  "alert_dialog",
  "drawer",
  "sheet",
  "popover",
  "menu",
  "tooltip",
]);

export const DialogNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("dialog"),
  role: DialogRoleSchema,
  modal: z.boolean(),
  label: LabelSchema,
}).strict();

export const FeedbackRoleSchema = z.enum([
  "alert",
  "status",
  "toast",
  "banner",
  "loading_indicator",
  "skeleton",
  "progress_bar",
  "meter",
  "error",
  "validation_summary",
  "empty_state",
  "cookie_consent",
  "permission_prompt",
  "live_region",
]);

export const FeedbackNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("feedback"),
  role: FeedbackRoleSchema,
  text: z.string().max(PAGE_NODE_TEXT_MAX_LENGTH).nullable(),
}).strict();

export const EmbeddedBoundaryTypeSchema = z.enum([
  "cross_origin_frame",
  "closed_shadow_root",
  "plugin",
  "inaccessible",
]);

export const EmbeddedBoundaryNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("embedded_boundary"),
  boundaryType: EmbeddedBoundaryTypeSchema,
  originOrTitle: z.string().max(300).nullable(),
  reason: z.string().min(1).max(300),
}).strict();

export const UnknownNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("unknown"),
  tagName: z.string().max(60).nullable(),
  observedRole: z.string().max(60).nullable(),
}).strict();

export const PageNodeSchema = z.discriminatedUnion("kind", [
  MetadataNodeSchema,
  LandmarkNodeSchema,
  TextNodeSchema,
  RichTextNodeSchema,
  ListNodeSchema,
  TableNodeSchema,
  RepeatedRecordNodeSchema,
  ImageNodeSchema,
  SvgChartNodeSchema,
  CanvasRegionNodeSchema,
  AudioNodeSchema,
  VideoNodeSchema,
  LinkNodeSchema,
  ControlNodeSchema,
  FormNodeSchema,
  FieldNodeSchema,
  OptionNodeSchema,
  DialogNodeSchema,
  FeedbackNodeSchema,
  EmbeddedBoundaryNodeSchema,
  UnknownNodeSchema,
]);

export type PageNode = z.infer<typeof PageNodeSchema>;
export type PageNodeKind = PageNode["kind"];
