import { z } from "zod";
import { HttpUrlSchema, IdSchema, IsoDateTimeSchema } from "./primitives";

/**
 * Citation contract: describes a claim-to-evidence link the model can
 * produce, and that a server-side resolver (see
 * `apps/renderer/src/server/citations/`) verifies against the actual
 * evidence text before it is ever rendered as a "supported" citation.
 *
 * Three shapes, from coarsest to finest:
 *   - `Source`: a single retrieved page/document (stable id, normalized
 *     http(s) URL, title, retrieval timestamp). Mirrors the identifying
 *     fields already carried by `EvidenceItem` (see `evidence.ts`), plus a
 *     stable `id` so a `Citation` can reference it without re-embedding the
 *     URL/title on every citation.
 *   - `EvidenceChunk`: a slice of normalized text taken from one `Source`
 *     (e.g. a paragraph or extracted snippet), the unit a `Citation`'s
 *     locator is resolved against.
 *   - `Citation`: a claimed reference from the model's answer to one
 *     `EvidenceChunk`, located either by an exact character span within
 *     that chunk's text, or by a content hash of the quoted text (robust to
 *     the chunk being re-segmented/re-fetched with minor whitespace drift).
 */

export const SOURCE_TITLE_MAX_LENGTH = 300;

export const SourceSchema = z
  .object({
    id: IdSchema,
    url: HttpUrlSchema,
    title: z.string().trim().min(1).max(SOURCE_TITLE_MAX_LENGTH),
    retrievedAt: IsoDateTimeSchema,
  })
  .strict();

export type Source = z.infer<typeof SourceSchema>;

export const EVIDENCE_CHUNK_TEXT_MAX_LENGTH = 8000;

/**
 * A single normalized slice of a `Source`'s text. `sourceId` must reference
 * a `Source.id` present in the same evidence bundle -- the resolver never
 * trusts a `sourceId` it did not itself receive alongside a matching
 * `Source`.
 */
export const EvidenceChunkSchema = z
  .object({
    id: IdSchema,
    sourceId: IdSchema,
    text: z.string().min(1).max(EVIDENCE_CHUNK_TEXT_MAX_LENGTH),
  })
  .strict();

export type EvidenceChunk = z.infer<typeof EvidenceChunkSchema>;

/**
 * Lowercase hex-encoded SHA-256 digest (64 hex characters) of a normalized
 * quoted substring. Fixed-length/format so it can appear inline in a
 * citation without leaking the underlying quote text on the wire, and so
 * the format itself is trivially validated independent of what hashing
 * strategy a producer used upstream.
 */
export const QUOTE_HASH_REGEX = /^[a-f0-9]{64}$/;

export const CitationSpanLocatorSchema = z
  .object({
    kind: z.literal("span"),
    /** Inclusive start offset (UTF-16 code units) into the chunk's `text`. */
    start: z.number().int().nonnegative(),
    /** Exclusive end offset (UTF-16 code units) into the chunk's `text`. */
    end: z.number().int().positive(),
  })
  .strict();

export const CitationQuoteHashLocatorSchema = z
  .object({
    kind: z.literal("quoteHash"),
    hash: z.string().regex(QUOTE_HASH_REGEX, "must be a lowercase 64-character hex SHA-256 digest"),
  })
  .strict();

/**
 * Closed discriminated shape: a citation locates its evidence either by an
 * exact character span, or by a quote hash (see `QUOTE_HASH_REGEX`).
 */
export const CitationLocatorSchema = z
  .discriminatedUnion("kind", [CitationSpanLocatorSchema, CitationQuoteHashLocatorSchema])
  .superRefine((value, ctx) => {
    if (value.kind === "span" && value.end <= value.start) {
      ctx.addIssue({ code: "custom", message: "span end must be greater than start", path: ["end"] });
    }
  });

export type CitationLocator = z.infer<typeof CitationLocatorSchema>;

export const CitationSchema = z
  .object({
    id: IdSchema,
    sourceId: IdSchema,
    chunkId: IdSchema,
    locator: CitationLocatorSchema,
  })
  .strict();

export type Citation = z.infer<typeof CitationSchema>;
