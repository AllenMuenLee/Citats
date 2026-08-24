import { createHash } from "node:crypto";
import type { Citation, EvidenceChunk, Source } from "@ai-browser/contracts";

/**
 * Server-side citation resolution.
 *
 * Accepted evidence shape (the "normalized evidence available from the
 * current tool invocation"):
 *
 *   { sources: Source[], chunks: EvidenceChunk[] }
 *
 * `sources`/`chunks` are the `Source`/`EvidenceChunk` shapes from
 * `@ai-browser/contracts/citation` (see that file for field definitions).
 * The intended pipeline for a later integration step is:
 *
 *   1. A tool result carries `EvidenceItem[]` (see
 *      `packages/contracts/src/evidence.ts`: `sourceUrl`, `title`,
 *      `snippet`, `retrievedAt`).
 *   2. For each distinct `sourceUrl`, mint a stable `Source` (a per-session
 *      id, the URL, title, retrievedAt) -- one `Source` per distinct page,
 *      not per `EvidenceItem`, if the same page produced multiple
 *      snippets.
 *   3. For each `EvidenceItem`, mint one (or more, if the item's `snippet`
 *      is further split) `EvidenceChunk` referencing that `Source`'s id,
 *      with `text` set to the item's normalized `snippet` text -- the exact
 *      text a `Citation`'s span/quote-hash locator is checked against.
 *   4. Call `resolveCitations({ sources, chunks }, claimedCitations)` with
 *      the citations the model produced for this turn.
 *
 * This module never trusts a `sourceId`/`chunkId` the model supplies unless
 * it matches a `Source`/`EvidenceChunk` actually present in the evidence
 * bundle passed in for *this* resolution call -- there is no fallback
 * lookup elsewhere (a prior turn's evidence, a global cache, etc.).
 */

export interface EvidenceBundle {
  sources: readonly Source[];
  chunks: readonly EvidenceChunk[];
}

export type CitationRejectionReason =
  | "unknown_source"
  | "unknown_chunk"
  | "chunk_source_mismatch"
  | "span_out_of_bounds"
  | "quote_hash_mismatch"
  | "duplicate_id"
  | "conflicting_id";

export interface ResolvedCitation {
  readonly citation: Citation;
  readonly source: Source;
  readonly chunk: EvidenceChunk;
  /** The exact evidence text this citation was matched against. */
  readonly excerpt: string;
}

export interface RejectedCitation {
  readonly citation: Citation;
  readonly reason: CitationRejectionReason;
  readonly detail: string;
}

export interface CitationResolutionResult {
  readonly valid: readonly ResolvedCitation[];
  readonly invalid: readonly RejectedCitation[];
}

/**
 * Normalizes text for quote-hash comparison: trims and collapses runs of
 * whitespace to a single space. This makes quote hashing robust to minor
 * re-flow/whitespace drift between when a quote hash was computed and when
 * the underlying page text was re-extracted, without allowing an
 * open-ended fuzzy match.
 */
export function normalizeQuoteText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** SHA-256 hex digest of the normalized text, matching `QUOTE_HASH_REGEX` in `@ai-browser/contracts`. */
export function computeQuoteHash(text: string): string {
  return createHash("sha256").update(normalizeQuoteText(text), "utf8").digest("hex");
}

/**
 * Candidate quotable segments within a chunk's text that a `quoteHash`
 * locator may match: the whole chunk, and each sentence-like segment
 * within it. Splitting on sentence boundaries (rather than requiring the
 * model to match the entire chunk verbatim) is what makes quote-hash
 * citations usable for a chunk that spans multiple sentences.
 */
function candidateQuoteSegments(chunkText: string): string[] {
  const segments = new Set<string>();
  const whole = normalizeQuoteText(chunkText);
  if (whole.length > 0) {
    segments.add(whole);
  }
  for (const sentence of chunkText.split(/(?<=[.!?])\s+/)) {
    const normalized = normalizeQuoteText(sentence);
    if (normalized.length > 0) {
      segments.add(normalized);
    }
  }
  return [...segments];
}

function sameCitationShape(a: Citation, b: Citation): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.chunkId === b.chunkId &&
    JSON.stringify(a.locator) === JSON.stringify(b.locator)
  );
}

/**
 * Resolves a list of model-claimed citations against the evidence actually
 * available for the current tool invocation. Never throws: every citation
 * ends up in exactly one of `valid`/`invalid`.
 */
export function resolveCitations(evidence: EvidenceBundle, claimed: readonly Citation[]): CitationResolutionResult {
  const sourceById = new Map(evidence.sources.map((source) => [source.id, source]));
  const chunkById = new Map(evidence.chunks.map((chunk) => [chunk.id, chunk]));

  const valid: ResolvedCitation[] = [];
  const invalid: RejectedCitation[] = [];
  const firstSeenById = new Map<string, Citation>();

  for (const citation of claimed) {
    const priorClaim = firstSeenById.get(citation.id);
    if (priorClaim) {
      invalid.push({
        citation,
        reason: sameCitationShape(priorClaim, citation) ? "duplicate_id" : "conflicting_id",
        detail: `citation id '${citation.id}' was already used earlier in this answer`,
      });
      continue;
    }
    firstSeenById.set(citation.id, citation);

    const source = sourceById.get(citation.sourceId);
    if (!source) {
      invalid.push({
        citation,
        reason: "unknown_source",
        detail: `sourceId '${citation.sourceId}' is not present in the evidence for this invocation`,
      });
      continue;
    }

    const chunk = chunkById.get(citation.chunkId);
    if (!chunk) {
      invalid.push({
        citation,
        reason: "unknown_chunk",
        detail: `chunkId '${citation.chunkId}' is not present in the evidence for this invocation`,
      });
      continue;
    }

    if (chunk.sourceId !== citation.sourceId) {
      invalid.push({
        citation,
        reason: "chunk_source_mismatch",
        detail: `chunk '${chunk.id}' belongs to source '${chunk.sourceId}', not '${citation.sourceId}'`,
      });
      continue;
    }

    const locator = citation.locator;
    if (locator.kind === "span") {
      const { start, end } = locator;
      if (start < 0 || end > chunk.text.length || end <= start) {
        invalid.push({
          citation,
          reason: "span_out_of_bounds",
          detail: `span [${start}, ${end}) is out of bounds for chunk '${chunk.id}' (length ${chunk.text.length})`,
        });
        continue;
      }
      valid.push({ citation, source, chunk, excerpt: chunk.text.slice(start, end) });
      continue;
    }

    // locator.kind === "quoteHash"
    const match = candidateQuoteSegments(chunk.text).find(
      (segment) => computeQuoteHash(segment) === locator.hash,
    );
    if (!match) {
      invalid.push({
        citation,
        reason: "quote_hash_mismatch",
        detail: `no segment of chunk '${chunk.id}' hashes to '${locator.hash}'`,
      });
      continue;
    }
    valid.push({ citation, source, chunk, excerpt: match });
  }

  return { valid, invalid };
}
