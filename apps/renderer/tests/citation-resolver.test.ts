import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Citation, EvidenceChunk, Source } from "@ai-browser/contracts";
import { computeQuoteHash, resolveCitations, type EvidenceBundle } from "../src/server/citations";

const source: Source = {
  id: "source-0001",
  url: "https://example.com/article",
  title: "Example Article",
  retrievedAt: "2026-08-22T00:00:00Z",
};

const otherSource: Source = {
  id: "source-0002",
  url: "https://example.com/other",
  title: "Other Article",
  retrievedAt: "2026-08-22T00:00:00Z",
};

const chunk: EvidenceChunk = {
  id: "chunk-0001",
  sourceId: "source-0001",
  text: "The quick brown fox jumps over the lazy dog. It was a sunny day.",
};

const evidence: EvidenceBundle = { sources: [source, otherSource], chunks: [chunk] };

function span(id: string, start: number, end: number): Citation {
  return { id, sourceId: source.id, chunkId: chunk.id, locator: { kind: "span", start, end } };
}

function quoteHash(id: string, hash: string): Citation {
  return { id, sourceId: source.id, chunkId: chunk.id, locator: { kind: "quoteHash", hash } };
}

describe("resolveCitations", () => {
  it("resolves a valid span citation with the correct excerpt", () => {
    const result = resolveCitations(evidence, [span("c1", 4, 9)]);
    expect(result.invalid).toEqual([]);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.excerpt).toBe("quick");
    expect(result.valid[0]?.source).toEqual(source);
    expect(result.valid[0]?.chunk).toEqual(chunk);
  });

  it("resolves a valid quote-hash citation matching a whole sentence", () => {
    const hash = computeQuoteHash("It was a sunny day.");
    const result = resolveCitations(evidence, [quoteHash("c1", hash)]);
    expect(result.invalid).toEqual([]);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.excerpt).toBe("It was a sunny day.");
  });

  it("resolves a valid quote-hash citation matching the whole chunk", () => {
    const hash = computeQuoteHash(chunk.text);
    const result = resolveCitations(evidence, [quoteHash("c1", hash)]);
    expect(result.valid).toHaveLength(1);
  });

  it("is robust to whitespace drift when hashing a quote", () => {
    const hash = computeQuoteHash("  It   was a sunny day.  ");
    const result = resolveCitations(evidence, [quoteHash("c1", hash)]);
    expect(result.valid).toHaveLength(1);
  });

  it("rejects a span that is out of bounds", () => {
    const result = resolveCitations(evidence, [span("c1", 0, 999)]);
    expect(result.valid).toEqual([]);
    expect(result.invalid[0]?.reason).toBe("span_out_of_bounds");
  });

  it("rejects a span with end <= start", () => {
    const result = resolveCitations(evidence, [
      { id: "c1", sourceId: source.id, chunkId: chunk.id, locator: { kind: "span", start: 5, end: 5 } },
    ]);
    expect(result.invalid[0]?.reason).toBe("span_out_of_bounds");
  });

  it("rejects a quote hash that matches nothing in the chunk", () => {
    const result = resolveCitations(evidence, [quoteHash("c1", computeQuoteHash("not in the chunk at all"))]);
    expect(result.invalid[0]?.reason).toBe("quote_hash_mismatch");
  });

  it("rejects an unknown sourceId never present in the evidence bundle", () => {
    const citation: Citation = { id: "c1", sourceId: "source-9999", chunkId: chunk.id, locator: { kind: "span", start: 0, end: 3 } };
    const result = resolveCitations(evidence, [citation]);
    expect(result.invalid[0]?.reason).toBe("unknown_source");
  });

  it("rejects an unknown chunkId never present in the evidence bundle", () => {
    const citation: Citation = { id: "c1", sourceId: source.id, chunkId: "chunk-9999", locator: { kind: "span", start: 0, end: 3 } };
    const result = resolveCitations(evidence, [citation]);
    expect(result.invalid[0]?.reason).toBe("unknown_chunk");
  });

  it("rejects a citation whose chunk belongs to a different source than claimed", () => {
    const citation: Citation = { id: "c1", sourceId: otherSource.id, chunkId: chunk.id, locator: { kind: "span", start: 0, end: 3 } };
    const result = resolveCitations(evidence, [citation]);
    expect(result.invalid[0]?.reason).toBe("chunk_source_mismatch");
  });

  it("never trusts a sourceId/chunkId that merely looks well-formed but was not in the passed-in evidence", () => {
    const emptyEvidence: EvidenceBundle = { sources: [], chunks: [] };
    const result = resolveCitations(emptyEvidence, [span("c1", 0, 3)]);
    expect(result.valid).toEqual([]);
    expect(result.invalid[0]?.reason).toBe("unknown_source");
  });

  it("treats a repeated identical citation id as a harmless duplicate", () => {
    const first = span("c1", 4, 9);
    const result = resolveCitations(evidence, [first, { ...first }]);
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.reason).toBe("duplicate_id");
  });

  it("treats a repeated citation id pointing at different evidence as a conflict", () => {
    const first = span("c1", 4, 9);
    const conflicting = span("c1", 10, 15);
    const result = resolveCitations(evidence, [first, conflicting]);
    expect(result.valid).toHaveLength(1);
    expect(result.invalid[0]?.reason).toBe("conflicting_id");
  });

  it("never throws on a batch mixing valid and every kind of invalid citation", () => {
    const citations: Citation[] = [
      span("c1", 4, 9),
      span("c2", 0, 9999),
      quoteHash("c3", "z".repeat(64)),
      { id: "c4", sourceId: "missing", chunkId: chunk.id, locator: { kind: "span", start: 0, end: 1 } },
      { id: "c5", sourceId: source.id, chunkId: "missing", locator: { kind: "span", start: 0, end: 1 } },
    ];
    expect(() => resolveCitations(evidence, citations)).not.toThrow();
    const result = resolveCitations(evidence, citations);
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(4);
  });
});
