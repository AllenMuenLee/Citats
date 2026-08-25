import { z } from "zod";
import { HttpUrlSchema, IsoDateTimeSchema } from "../primitives";
import { ObservationStatusSchema, OpaqueHandleSchema } from "./common";
import {
  MAX_COVERAGE_NOTES,
  MAX_INTERACTION_CAPABILITIES,
  MAX_PAGE_COLLECTIONS,
  MAX_PAGE_NODES,
  MAX_PAGE_REGIONS,
  MAX_PAGE_RELATIONSHIPS,
  MAX_PAGE_TRUNCATIONS,
  MAX_PAGE_WARNINGS,
  MAX_REGION_CHILD_HANDLES,
  MAX_SOURCE_CANDIDATES,
} from "./limits";
import { InteractionCapabilitySchema } from "./capability";
import { PageNodeSchema } from "./nodes";
import { PageRelationshipSchema } from "./relationships";
import { RepeatedCollectionSchema, UiSourceCandidateSchema } from "./source-candidate";

export const PAGE_TITLE_MAX_LENGTH = 500;
export const PAGE_DESCRIPTION_MAX_LENGTH = 1_000;

/** Mission item 1: document and page metadata. A category that is absent/untrustworthy is `null`, never fabricated. */
export const PageMetadataSchema = z
  .object({
    finalUrl: HttpUrlSchema,
    origin: z.string().max(255),
    title: z.string().max(PAGE_TITLE_MAX_LENGTH).nullable(),
    language: z.string().max(35).nullable(),
    description: z.string().max(PAGE_DESCRIPTION_MAX_LENGTH).nullable(),
    author: z.string().max(200).nullable(),
    publishedTime: IsoDateTimeSchema.nullable(),
    updatedTime: IsoDateTimeSchema.nullable(),
    favicon: HttpUrlSchema.nullable(),
    themeColor: z.string().max(30).nullable(),
    viewportHint: z.string().max(200).nullable(),
    documentDirection: z.enum(["ltr", "rtl", "auto"]).nullable(),
    contentType: z.string().max(200).nullable(),
    charset: z.string().max(60).nullable(),
    robots: z.string().max(200).nullable(),
  })
  .strict();

export type PageMetadata = z.infer<typeof PageMetadataSchema>;

/** Mission item 13: bounded viewport/scroll facts, not a full layout dump. */
export const ViewportStateSchema = z
  .object({
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    scrollX: z.number().nonnegative(),
    scrollY: z.number().nonnegative(),
    scrollHeight: z.number().nonnegative(),
    devicePixelRatio: z.number().positive().nullable(),
  })
  .strict();

export type ViewportState = z.infer<typeof ViewportStateSchema>;

export const PageWarningCodeSchema = z.enum([
  "hidden_injection_detected",
  "credential_like_content",
  "node_limit_reached",
  "relationship_limit_reached",
  "text_truncated",
  "media_truncated",
  "collection_truncated",
  "cross_origin_boundary",
  "closed_shadow_boundary",
  "settle_timeout",
  "settle_unstable",
  "media_unavailable",
  "sensitive_field_omitted",
  "unsafe_url_blocked",
  "depth_limit_reached",
  "handle_not_found",
  "handle_expired",
]);

export type PageWarningCode = z.infer<typeof PageWarningCodeSchema>;

export const PageWarningSchema = z
  .object({
    code: PageWarningCodeSchema,
    message: z.string().min(1).max(500),
    nodeHandle: OpaqueHandleSchema.nullable(),
  })
  .strict();

export type PageWarning = z.infer<typeof PageWarningSchema>;

export const PageTruncationCategorySchema = z.enum(["nodes", "text", "media", "relationships", "collections"]);

export const PageTruncationSchema = z
  .object({
    reason: z.string().min(1).max(200),
    category: PageTruncationCategorySchema,
    removedCount: z.number().int().nonnegative(),
  })
  .strict();

export type PageTruncation = z.infer<typeof PageTruncationSchema>;

/** P03-F04 step 6's coverage report -- never claims "every action" was found when bounded/inaccessible states remain. */
export const CoverageReportSchema = z
  .object({
    observedControlCount: z.number().int().nonnegative(),
    safelyExploredControlCount: z.number().int().nonnegative(),
    prohibitedControlCount: z.number().int().nonnegative(),
    unknownControlCount: z.number().int().nonnegative(),
    inaccessibleRegionCount: z.number().int().nonnegative(),
    unobservedLazyStateCount: z.number().int().nonnegative(),
    notes: z.array(z.string().max(300)).max(MAX_COVERAGE_NOTES),
  })
  .strict();

export type CoverageReport = z.infer<typeof CoverageReportSchema>;

/** Mission item: a bounded landmark/grouping region and the node handles it directly contains. */
export const PageRegionSchema = z
  .object({
    handle: OpaqueHandleSchema,
    role: z.string().min(1).max(60),
    label: z.string().max(300).nullable(),
    childHandles: z.array(OpaqueHandleSchema).max(MAX_REGION_CHILD_HANDLES),
  })
  .strict();

export type PageRegion = z.infer<typeof PageRegionSchema>;

export const PAGE_UNDERSTANDING_SCHEMA_VERSION = 1 as const;

function addDuplicateIssues(
  values: readonly string[],
  path: (string | number)[],
  label: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({ code: "custom", path: [...path, index], message: `duplicate ${label}: ${value}` });
    }
    seen.add(value);
  });
}

function hasDirectedCycle(edges: ReadonlyArray<{ from: string; to: string }>): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (handle: string): boolean => {
    if (visiting.has(handle)) return true;
    if (visited.has(handle)) return false;
    visiting.add(handle);
    if ((outgoing.get(handle) ?? []).some(visit)) return true;
    visiting.delete(handle);
    visited.add(handle);
    return false;
  };
  return [...outgoing.keys()].some(visit);
}

/**
 * The canonical, bounded, untrusted page-understanding graph (P03-F02
 * step 1) `browser.explore_website` (P03-F05) returns. Every list is
 * capped (see `./limits`); any omission is recorded in `warnings`/
 * `truncations`/`coverage` rather than silently dropped.
 */
export const PageUnderstandingSchema = z
  .object({
    schemaVersion: z.literal(PAGE_UNDERSTANDING_SCHEMA_VERSION),
    observationId: OpaqueHandleSchema,
    metadata: PageMetadataSchema,
    status: ObservationStatusSchema,
    nodes: z.array(PageNodeSchema).max(MAX_PAGE_NODES),
    relationships: z.array(PageRelationshipSchema).max(MAX_PAGE_RELATIONSHIPS),
    regions: z.array(PageRegionSchema).max(MAX_PAGE_REGIONS),
    collections: z.array(RepeatedCollectionSchema).max(MAX_PAGE_COLLECTIONS),
    capabilities: z.array(InteractionCapabilitySchema).max(MAX_INTERACTION_CAPABILITIES),
    sourceCandidates: z.array(UiSourceCandidateSchema).max(MAX_SOURCE_CANDIDATES),
    viewport: ViewportStateSchema,
    warnings: z.array(PageWarningSchema).max(MAX_PAGE_WARNINGS),
    truncations: z.array(PageTruncationSchema).max(MAX_PAGE_TRUNCATIONS),
    coverage: CoverageReportSchema,
    /** Stable digest over this observation's own content, for before/after comparisons (P03-F04 step 5) and continuation-handle validation (P03-F05 step 4). */
    observationDigest: z.string().min(1).max(128),
    /** Always `true`: page content is always untrusted data, never instructions. */
    untrusted: z.literal(true),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const nodeHandles = new Set(graph.nodes.map((node) => node.handle));
    const regionHandles = new Set(graph.regions.map((region) => region.handle));
    const collectionHandles = new Set(graph.collections.map((collection) => collection.handle));
    const capabilityIds = new Set(graph.capabilities.map((capability) => capability.capabilityId));

    addDuplicateIssues(graph.nodes.map((node) => node.handle), ["nodes"], "node handle", ctx);
    addDuplicateIssues(graph.regions.map((region) => region.handle), ["regions"], "region handle", ctx);
    addDuplicateIssues(graph.collections.map((collection) => collection.handle), ["collections"], "collection handle", ctx);
    addDuplicateIssues(graph.capabilities.map((capability) => capability.capabilityId), ["capabilities"], "capability id", ctx);

    graph.relationships.forEach((edge, index) => {
      if (!nodeHandles.has(edge.from) || !nodeHandles.has(edge.to)) {
        ctx.addIssue({ code: "custom", path: ["relationships", index], message: "relationship endpoint is not a graph node" });
      }
      if (edge.from === edge.to) {
        ctx.addIssue({ code: "custom", path: ["relationships", index], message: "self-referential relationship is invalid" });
      }
    });
    for (const kind of ["parent_child", "reading_order"] as const) {
      if (hasDirectedCycle(graph.relationships.filter((edge) => edge.kind === kind))) {
        ctx.addIssue({ code: "custom", path: ["relationships"], message: `${kind} relationships must be acyclic` });
      }
    }

    graph.regions.forEach((region, index) => region.childHandles.forEach((handle, childIndex) => {
      if (!nodeHandles.has(handle)) ctx.addIssue({ code: "custom", path: ["regions", index, "childHandles", childIndex], message: "region child is not a graph node" });
    }));
    graph.collections.forEach((collection, index) => {
      addDuplicateIssues(collection.recordHandles, ["collections", index, "recordHandles"], "record handle", ctx);
      collection.recordHandles.forEach((handle, recordIndex) => {
        const node = graph.nodes.find((candidate) => candidate.handle === handle);
        if (node?.kind !== "repeated_record" || node.collectionHandle !== collection.handle) {
          ctx.addIssue({ code: "custom", path: ["collections", index, "recordHandles", recordIndex], message: "record must belong to this collection" });
        }
      });
    });
    graph.nodes.forEach((node, index) => {
      if (node.kind === "repeated_record" && !collectionHandles.has(node.collectionHandle)) {
        ctx.addIssue({ code: "custom", path: ["nodes", index, "collectionHandle"], message: "record references an unknown collection" });
      }
    });
    graph.capabilities.forEach((capability, index) => {
      if (!nodeHandles.has(capability.controlHandle)) ctx.addIssue({ code: "custom", path: ["capabilities", index, "controlHandle"], message: "capability control is not a graph node" });
      if (capability.owningHandle !== null && !nodeHandles.has(capability.owningHandle) && !regionHandles.has(capability.owningHandle) && !collectionHandles.has(capability.owningHandle)) {
        ctx.addIssue({ code: "custom", path: ["capabilities", index, "owningHandle"], message: "capability owner is unknown" });
      }
    });
    graph.sourceCandidates.forEach((candidate, index) => {
      if (!collectionHandles.has(candidate.collectionHandle)) ctx.addIssue({ code: "custom", path: ["sourceCandidates", index, "collectionHandle"], message: "source candidate collection is unknown" });
      if (candidate.recordHandle !== null && !nodeHandles.has(candidate.recordHandle)) ctx.addIssue({ code: "custom", path: ["sourceCandidates", index, "recordHandle"], message: "source candidate record is unknown" });
      candidate.fields.forEach((field, fieldIndex) => {
        if (!nodeHandles.has(field.nodeHandle)) ctx.addIssue({ code: "custom", path: ["sourceCandidates", index, "fields", fieldIndex, "nodeHandle"], message: "field mapping node is unknown" });
      });
      candidate.actionCapabilityIds.forEach((id, actionIndex) => {
        if (!capabilityIds.has(id)) ctx.addIssue({ code: "custom", path: ["sourceCandidates", index, "actionCapabilityIds", actionIndex], message: "source action capability is unknown" });
      });
    });

    const collectionOmission = graph.collections.some((collection) => collection.truncated);
    if (collectionOmission && !graph.truncations.some((item) => item.category === "collections" && item.removedCount > 0)) {
      ctx.addIssue({ code: "custom", path: ["truncations"], message: "truncated collections require non-zero truncation accounting" });
    }
  });

export type PageUnderstanding = z.infer<typeof PageUnderstandingSchema>;
