import { z } from "zod";
import { ToolDefinitionSchema } from "../tool-definition";
import { OpaqueHandleSchema, PageNodeSchema, PageRelationshipSchema, PageWarningSchema } from "../page-understanding";

/**
 * `browser.get_page_understanding_slice` -- Phase 3 (P03-F05 step 4)
 * continuation-handle tool. Lets the model request additional bounded
 * slices of a `PageUnderstanding` graph it already received (a region,
 * collection, or record handle) instead of the whole graph being placed in
 * every model turn. `observationId` + `handle` are validated for
 * ownership (this session's own observation), digest match, and expiry on
 * every request (see
 * `services/browser/src/browser_service/page_observation/handles.py`) --
 * an unowned, expired, or unknown handle returns `found: false` with an
 * explicit warning rather than another session's data or a raw error.
 */
export const GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME = "browser.get_page_understanding_slice" as const;

export const GetPageUnderstandingSliceArgsSchema = z
  .object({
    observationId: OpaqueHandleSchema,
    handle: OpaqueHandleSchema,
  })
  .strict();

export type GetPageUnderstandingSliceArgs = z.infer<typeof GetPageUnderstandingSliceArgsSchema>;

export const MAX_SLICE_NODES = 100;
export const MAX_SLICE_RELATIONSHIPS = 200;

export const GetPageUnderstandingSliceResultSchema = z
  .object({
    found: z.boolean(),
    nodes: z.array(PageNodeSchema).max(MAX_SLICE_NODES),
    relationships: z.array(PageRelationshipSchema).max(MAX_SLICE_RELATIONSHIPS),
    truncated: z.boolean(),
    warnings: z.array(PageWarningSchema).max(10),
    untrusted: z.literal(true),
  })
  .strict();

export type GetPageUnderstandingSliceResult = z.infer<typeof GetPageUnderstandingSliceResultSchema>;

export const GetPageUnderstandingSliceToolDefinition = ToolDefinitionSchema.parse({
  contractVersion: 1,
  name: GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME,
  description:
    "Retrieves one additional bounded slice (a region, collection, or record) of a page-understanding " +
    "graph a prior browser.explore_website call already returned, by its opaque observationId + handle. " +
    "Read-only and informational only -- never expands access beyond what that same observation already " +
    "described.",
  argsSchemaVersion: 1,
  argsSchemaRef: "browser.get_page_understanding_slice.v1",
  sensitiveByDefault: false,
});
