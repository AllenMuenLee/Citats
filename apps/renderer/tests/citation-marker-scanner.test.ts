import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CitationMarkerScanner } from "../src/server/citations/marker-scanner";

describe("CitationMarkerScanner", () => {
  it("passes through plain text with no markers unchanged", () => {
    const scanner = new CitationMarkerScanner();
    const result = scanner.push("Hello, world.");
    expect(result.clean).toBe("Hello, world.");
    expect(result.markers).toEqual([]);
  });

  it("extracts a complete marker delivered in one push and strips it from clean text", () => {
    const scanner = new CitationMarkerScanner();
    const result = scanner.push("The sky is blue.[[cite:chunk-0]] Next sentence.");
    expect(result.clean).toBe("The sky is blue. Next sentence.");
    expect(result.markers).toEqual([{ chunkId: "chunk-0", position: "The sky is blue.".length }]);
  });

  it("extracts a marker whose characters arrive split across multiple pushes", () => {
    const scanner = new CitationMarkerScanner();
    const first = scanner.push("A fact.[[cite:ch");
    expect(first.clean).toBe("A fact.");
    expect(first.markers).toEqual([]);

    const second = scanner.push("unk-7]] More text.");
    expect(second.clean).toBe(" More text.");
    expect(second.markers).toEqual([{ chunkId: "chunk-7", position: "A fact.".length }]);
  });

  it("extracts multiple markers in one push with correct cumulative positions", () => {
    const scanner = new CitationMarkerScanner();
    const result = scanner.push("One.[[cite:a]] Two.[[cite:b]] Three.");
    expect(result.clean).toBe("One. Two. Three.");
    expect(result.markers).toEqual([
      { chunkId: "a", position: "One.".length },
      { chunkId: "b", position: "One. Two.".length },
    ]);
  });

  it("holds back an in-progress marker prefix and only flushes it once it resolves", () => {
    const scanner = new CitationMarkerScanner();
    const step1 = scanner.push("Text before [");
    expect(step1.clean).toBe("Text before ");
    const step2 = scanner.push("[cite:x");
    expect(step2.clean).toBe("");
    const step3 = scanner.push("]]");
    expect(step3.clean).toBe("");
    expect(step3.markers).toEqual([{ chunkId: "x", position: "Text before ".length }]);
  });

  it("flush() emits an unresolved trailing prefix as literal text, never as a marker", () => {
    const scanner = new CitationMarkerScanner();
    const pushed = scanner.push("End of answer [[cite:incompl");
    expect(pushed.clean).toBe("End of answer ");
    const flushed = scanner.flush();
    expect(flushed.clean).toBe("[[cite:incompl");
    expect(flushed.markers).toEqual([]);
  });

  it("treats bracket text that never matches the marker prefix as ordinary literal text", () => {
    const scanner = new CitationMarkerScanner();
    const result = scanner.push("Array syntax: a[[0]] and b[1] are not citations.");
    expect(result.clean).toBe("Array syntax: a[[0]] and b[1] are not citations.");
    expect(result.markers).toEqual([]);
  });

  it("stops holding back once accumulated id-shaped text exceeds the bounded chunk-id length", () => {
    const scanner = new CitationMarkerScanner();
    const longRunOn = "[[cite:" + "a".repeat(100);
    const result = scanner.push(`before ${longRunOn} after`);
    // Once the pending run-on exceeds the max id length without closing
    // "]]", it can no longer be a valid marker prefix, so it must be
    // flushed as ordinary text rather than held back forever.
    expect(result.clean).toContain("before ");
    expect(result.clean.length).toBeGreaterThan("before ".length);
    expect(result.markers).toEqual([]);
  });

  it("never emits a marker id containing characters outside the allowed set", () => {
    const scanner = new CitationMarkerScanner();
    const result = scanner.push("claim [[cite:bad id!]] more");
    // "bad id!" is not a valid chunk id (space, "!"), so this must not be
    // parsed as a citation marker at all -- it passes through as text.
    expect(result.markers).toEqual([]);
    expect(result.clean + scanner.flush().clean).toContain("[[cite:bad id!]]");
  });
});
