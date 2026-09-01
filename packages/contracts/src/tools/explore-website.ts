import { z } from "zod";
import { HttpUrlSchema } from "../primitives";
import { ToolDefinitionSchema } from "../tool-definition";
import {
  ExtractedAccessibilityNodeSchema,
  ExtractedChunkSchema,
  ExtractionTruncationSchema,
  ExtractionWarningSchema,
  MAX_EXTRACTED_ACCESSIBILITY_NODES,
  MAX_EXTRACTED_CHUNKS,
  NavigateAndExtractMetadataSchema,
} from "./navigate-and-extract";
import { PageUnderstandingSchema } from "../page-understanding";

/**
 * `browser.explore_website` -- Phase 3 (P03-F05) website-capability
 * exploration tool. Reuses one Phase 2 isolated page/navigation (never a
 * second navigation), then observes the rendered page. URL + a bounded
 * free-text goal only -- lower-level DOM/CDP primitives, capture options,
 * and exploration policy remain server-owned (see
 * `services/browser/src/browser_service/tools/explore_website.py`).
 *
 * The result's `document` sub-shape is exactly the same citable
 * `metadata`/`chunks`/`warnings`/`truncations` shape
 * `browser.navigate_and_extract` returns, so this tool's evidence
 * participates in the existing citation pipeline unchanged; `pageUnderstanding`
 * is the new, separate, bounded capability graph (P03-F02). Never returns
 * raw HTML, arbitrary attributes, scripts/styles, screenshots by default,
 * network observations, endpoint maps, or callable APIs.
 */
export const EXPLORE_WEBSITE_TOOL_NAME = "browser.explore_website" as const;

export const EXPLORE_WEBSITE_GOAL_MAX_LENGTH = 500;

export const ExploreWebsiteArgsSchema = z
  .object({
    url: HttpUrlSchema,
    goal: z.string().max(EXPLORE_WEBSITE_GOAL_MAX_LENGTH).optional(),
  })
  .strict();

export type ExploreWebsiteArgs = z.infer<typeof ExploreWebsiteArgsSchema>;

export const ExploreWebsiteDocumentSchema = z
  .object({
    metadata: NavigateAndExtractMetadataSchema,
    accessibility: z.array(ExtractedAccessibilityNodeSchema).max(MAX_EXTRACTED_ACCESSIBILITY_NODES),
    chunks: z.array(ExtractedChunkSchema).max(MAX_EXTRACTED_CHUNKS),
    warnings: z.array(ExtractionWarningSchema).max(100),
    truncations: z.array(ExtractionTruncationSchema).max(50),
  })
  .strict();

export type ExploreWebsiteDocument = z.infer<typeof ExploreWebsiteDocumentSchema>;

export const ExploreWebsiteTimingSchema = z
  .object({
    navigationMs: z.number().nonnegative(),
    extractionMs: z.number().nonnegative(),
    observationMs: z.number().nonnegative(),
    totalMs: z.number().nonnegative(),
  })
  .strict();

export const ExploreWebsiteResultSchema = z
  .object({
    document: ExploreWebsiteDocumentSchema,
    pageUnderstanding: PageUnderstandingSchema,
    timing: ExploreWebsiteTimingSchema,
    /** Always `true`: page content is always untrusted data, never instructions. */
    untrusted: z.literal(true),
  })
  .strict();

export type ExploreWebsiteResult = z.infer<typeof ExploreWebsiteResultSchema>;

export const ExploreWebsiteToolDefinition = ToolDefinitionSchema.parse({
  contractVersion: 1,
  name: EXPLORE_WEBSITE_TOOL_NAME,
  description:
    "Navigates to a public http(s) URL, reads bounded citable page content, and observes the " +
    "rendered page's structure, media, forms, and controls as a bounded, untrusted capability graph. " +
    "Read-only: never fills forms, clicks, submits, downloads, or executes any mutating request. " +
    "Prefer this over browser.navigate_and_extract for pages with structured records (search " +
    "results, listings, schedules). Any capability it reports is informational only, never callable.",
  argsSchemaVersion: 1,
  argsSchemaRef: "browser.explore_website.v1",
  sensitiveByDefault: false,
});
