import { describe, expect, it } from "vitest";
import {
  CitationLocatorSchema,
  CitationSchema,
  EvidenceChunkSchema,
  QUOTE_HASH_REGEX,
  SourceSchema,
} from "../src/citation.js";

const validSource = {
  id: "source-0001",
  url: "https://example.com/article",
  title: "Example Article",
  retrievedAt: "2026-08-22T00:00:00Z",
};

const validChunk = {
  id: "chunk-0001",
  sourceId: "source-0001",
  text: "The quick brown fox jumps over the lazy dog.",
};

const SHA256_HEX = "a".repeat(64);

describe("SourceSchema", () => {
  it("accepts a well-formed source", () => {
    expect(SourceSchema.safeParse(validSource).success).toBe(true);
  });

  it("rejects a non-http(s) URL", () => {
    const result = SourceSchema.safeParse({ ...validSource, url: "javascript:alert(1)" });
    expect(result.success).toBe(false);
  });

  it("rejects an extra unexpected field (strict)", () => {
    const result = SourceSchema.safeParse({ ...validSource, extra: "nope" });
    expect(result.success).toBe(false);
  });

  it("rejects a blank title", () => {
    const result = SourceSchema.safeParse({ ...validSource, title: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO retrievedAt", () => {
    const result = SourceSchema.safeParse({ ...validSource, retrievedAt: "not-a-date" });
    expect(result.success).toBe(false);
  });
});

describe("EvidenceChunkSchema", () => {
  it("accepts a well-formed chunk", () => {
    expect(EvidenceChunkSchema.safeParse(validChunk).success).toBe(true);
  });

  it("rejects an empty text", () => {
    expect(EvidenceChunkSchema.safeParse({ ...validChunk, text: "" }).success).toBe(false);
  });

  it("rejects an extra unexpected field (strict)", () => {
    expect(EvidenceChunkSchema.safeParse({ ...validChunk, extra: 1 }).success).toBe(false);
  });
});

describe("CitationLocatorSchema", () => {
  it("accepts a valid span locator", () => {
    const result = CitationLocatorSchema.safeParse({ kind: "span", start: 0, end: 9 });
    expect(result.success).toBe(true);
  });

  it("rejects a span where end <= start", () => {
    expect(CitationLocatorSchema.safeParse({ kind: "span", start: 5, end: 5 }).success).toBe(false);
    expect(CitationLocatorSchema.safeParse({ kind: "span", start: 5, end: 2 }).success).toBe(false);
  });

  it("rejects a negative start", () => {
    expect(CitationLocatorSchema.safeParse({ kind: "span", start: -1, end: 4 }).success).toBe(false);
  });

  it("accepts a valid quote-hash locator", () => {
    expect(QUOTE_HASH_REGEX.test(SHA256_HEX)).toBe(true);
    const result = CitationLocatorSchema.safeParse({ kind: "quoteHash", hash: SHA256_HEX });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed quote hash", () => {
    expect(CitationLocatorSchema.safeParse({ kind: "quoteHash", hash: "not-hex" }).success).toBe(false);
    expect(CitationLocatorSchema.safeParse({ kind: "quoteHash", hash: SHA256_HEX.toUpperCase() }).success).toBe(
      false,
    );
    expect(CitationLocatorSchema.safeParse({ kind: "quoteHash", hash: SHA256_HEX.slice(0, 10) }).success).toBe(
      false,
    );
  });

  it("rejects an unknown discriminant", () => {
    expect(CitationLocatorSchema.safeParse({ kind: "regex", pattern: ".*" }).success).toBe(false);
  });

  it("rejects mixed fields from both branches (strict per-branch)", () => {
    expect(
      CitationLocatorSchema.safeParse({ kind: "span", start: 0, end: 9, hash: SHA256_HEX }).success,
    ).toBe(false);
  });
});

describe("CitationSchema", () => {
  const validSpanCitation = {
    id: "citation-0001",
    sourceId: "source-0001",
    chunkId: "chunk-0001",
    locator: { kind: "span" as const, start: 0, end: 9 },
  };

  it("accepts a well-formed span citation", () => {
    expect(CitationSchema.safeParse(validSpanCitation).success).toBe(true);
  });

  it("accepts a well-formed quote-hash citation", () => {
    const result = CitationSchema.safeParse({
      ...validSpanCitation,
      locator: { kind: "quoteHash", hash: SHA256_HEX },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an extra unexpected top-level field (strict)", () => {
    expect(CitationSchema.safeParse({ ...validSpanCitation, extra: true }).success).toBe(false);
  });

  it("rejects an id that is not alphanumeric/_/-", () => {
    expect(CitationSchema.safeParse({ ...validSpanCitation, id: "bad id!" }).success).toBe(false);
  });
});
