import { z } from "zod";
import { HttpUrlSchema, IsoDateTimeSchema } from "../primitives";
import { ToolDefinitionSchema } from "../tool-definition";

/**
 * `browser.navigate_and_extract` -- Phase 2 (P02-F04) read-only browsing
 * tool. Composes the browser service's URL policy, browser lifecycle,
 * navigation service, and content-extraction pipeline (see
 * `services/browser/src/browser_service/tools/navigate_and_extract.py`)
 * into one bounded, read-only operation: navigate to a public `http`/
 * `https` URL and return structured, sanitized, bounded content the
 * model can cite.
 *
 * URL-only input, never sensitive (read-only, no state-changing
 * capability exists on this path), and its result payload carries only
 * *bounded* chunks -- never the full unbounded block/anchor/image tree
 * the browser service extracts internally -- so this is the shape
 * actually serialized to the model, per the phase's "serialize only
 * bounded extracted chunks to the model" requirement.
 */
export const NAVIGATE_AND_EXTRACT_TOOL_NAME = "browser.navigate_and_extract" as const;

export const NavigateAndExtractArgsSchema = z
  .object({
    url: HttpUrlSchema,
  })
  .strict();

export type NavigateAndExtractArgs = z.infer<typeof NavigateAndExtractArgsSchema>;

export const EXTRACTED_CHUNK_ID_MAX_LENGTH = 64;
export const EXTRACTED_CHUNK_TEXT_MAX_LENGTH = 8_000;
export const MAX_EXTRACTED_CHUNKS = 50;

/** A stable, bounded slice of the extracted document's canonical flattened text -- the unit a citation is resolved against. */
export const ExtractedChunkSchema = z
  .object({
    chunkId: z.string().min(1).max(EXTRACTED_CHUNK_ID_MAX_LENGTH),
    text: z.string().max(EXTRACTED_CHUNK_TEXT_MAX_LENGTH),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
  })
  .strict();

export type ExtractedChunk = z.infer<typeof ExtractedChunkSchema>;

/** Closed set of machine-readable extraction-warning categories (mirrors `browser_service.extraction.models.WarningCode`). */
export const ExtractionWarningCodeSchema = z.enum([
  "hidden_content_stripped",
  "credential_like_content",
  "prompt_injection_suspected",
  "document_truncated",
  "chunk_truncated",
  "chunk_limit_reached",
  "no_semantic_container",
]);

export type ExtractionWarningCode = z.infer<typeof ExtractionWarningCodeSchema>;

export const EXTRACTION_WARNING_MESSAGE_MAX_LENGTH = 500;

/**
 * A single advisory warning surfaced alongside the extracted document.
 * Never repeats the raw page-controlled text that triggered it (e.g. a
 * matched credential or injection phrase) -- only a category, a safe
 * human-readable note, and a document-local location.
 */
export const ExtractionWarningSchema = z
  .object({
    code: ExtractionWarningCodeSchema,
    message: z.string().min(1).max(EXTRACTION_WARNING_MESSAGE_MAX_LENGTH),
    blockId: z.string().max(EXTRACTED_CHUNK_ID_MAX_LENGTH).optional(),
    chunkId: z.string().max(EXTRACTED_CHUNK_ID_MAX_LENGTH).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ExtractionWarning = z.infer<typeof ExtractionWarningSchema>;

export const EXTRACTION_TRUNCATION_REASON_MAX_LENGTH = 200;

/** Records what was cut from the document and why -- truncation is always explicit, never silent. */
export const ExtractionTruncationSchema = z
  .object({
    reason: z.string().min(1).max(EXTRACTION_TRUNCATION_REASON_MAX_LENGTH),
    atChunkId: z.string().max(EXTRACTED_CHUNK_ID_MAX_LENGTH).optional(),
    atOffset: z.number().int().nonnegative().optional(),
    removedBlockCount: z.number().int().nonnegative(),
    removedChars: z.number().int().nonnegative(),
  })
  .strict();

export type ExtractionTruncation = z.infer<typeof ExtractionTruncationSchema>;

export const NAVIGATE_AND_EXTRACT_TITLE_MAX_LENGTH = 500;
export const NAVIGATE_AND_EXTRACT_DESCRIPTION_MAX_LENGTH = 1_000;

/** Document-level metadata captured only from trustworthy structured sources -- never guessed from free text. */
export const NavigateAndExtractMetadataSchema = z
  .object({
    title: z.string().min(1).max(NAVIGATE_AND_EXTRACT_TITLE_MAX_LENGTH),
    url: HttpUrlSchema,
    language: z.string().min(1).max(35),
    description: z.string().max(NAVIGATE_AND_EXTRACT_DESCRIPTION_MAX_LENGTH).nullable(),
    publishedTime: IsoDateTimeSchema.nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    contentType: z.string().max(200).nullable(),
  })
  .strict();

export type NavigateAndExtractMetadata = z.infer<typeof NavigateAndExtractMetadataSchema>;

/** Timing breakdown for the composed navigate+extract operation, in milliseconds. */
export const NavigateAndExtractTimingSchema = z
  .object({
    navigationMs: z.number().nonnegative(),
    extractionMs: z.number().nonnegative(),
    totalMs: z.number().nonnegative(),
  })
  .strict();

export type NavigateAndExtractTiming = z.infer<typeof NavigateAndExtractTimingSchema>;

export const NavigateAndExtractResultSchema = z
  .object({
    metadata: NavigateAndExtractMetadataSchema,
    chunks: z.array(ExtractedChunkSchema).max(MAX_EXTRACTED_CHUNKS),
    warnings: z.array(ExtractionWarningSchema).max(100),
    truncations: z.array(ExtractionTruncationSchema).max(50),
    timing: NavigateAndExtractTimingSchema,
    /** Always `true`: page content is always untrusted data, never instructions. */
    untrusted: z.literal(true),
  })
  .strict();

export type NavigateAndExtractResult = z.infer<typeof NavigateAndExtractResultSchema>;

export const NavigateAndExtractToolDefinition = ToolDefinitionSchema.parse({
  contractVersion: 1,
  name: NAVIGATE_AND_EXTRACT_TOOL_NAME,
  description:
    "Navigates to a public http(s) URL and returns bounded, structured, citable page content. " +
    "Read-only: never fills forms, clicks, submits, or uses authenticated sessions.",
  argsSchemaVersion: 1,
  argsSchemaRef: "browser.navigate_and_extract.v1",
  sensitiveByDefault: false,
});
