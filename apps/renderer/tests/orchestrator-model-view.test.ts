import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CONTRACT_MAJOR_VERSION, EXPLORE_WEBSITE_TOOL_NAME, NAVIGATE_AND_EXTRACT_TOOL_NAME } from "@ai-browser/contracts";
import type { ConversationTurn } from "../src/server/ai";
import { elideOldToolResults, estimateTurnTokens, projectToolResultForModel } from "../src/server/orchestrator/model-view";
import { buildExploreResult } from "./helpers/explore-result";

describe("projectToolResultForModel", () => {
  const full = buildExploreResult();
  const projected = projectToolResultForModel(EXPLORE_WEBSITE_TOOL_NAME, full) as {
    payload: {
      document: { chunks: Array<{ chunkId: string; text: string }>; omittedChunkCount: number; truncatedChunkCount: number };
      pageUnderstanding: {
        observationId: string;
        collections: Array<{ handle: string; fieldRoles: string[] }>;
        regions: Array<{ handle: string }>;
        capabilities: Array<{ capabilityId: string }>;
        counts: { nodes: number };
      };
    };
  };

  it("cuts a mid-sized explore result to a small fraction of its serialized size", () => {
    const before = JSON.stringify(full).length;
    const after = JSON.stringify(projected).length;
    expect(before).toBeGreaterThan(100_000);
    expect(after).toBeLessThan(before / 8);
    // What remains is dominated by citable chunk text, which is capped outright.
    expect(after).toBeLessThan(14_000);
    // The whole capability graph now costs less than a page of text.
    expect(JSON.stringify(projected.payload.pageUnderstanding).length).toBeLessThan(5_500);
  });

  it("keeps every identifier the plan and slice tools accept", () => {
    const understanding = projected.payload.pageUnderstanding;
    expect(understanding.observationId).toBe("obs-1");
    expect(understanding.collections.map((collection) => collection.handle)).toEqual(["col-search-results", "col-related-items"]);
    expect(understanding.collections[0]?.fieldRoles).toEqual(["title", "description", "image", "price", "rating"]);
    expect(understanding.regions).toHaveLength(10);
    expect(understanding.capabilities.length).toBeGreaterThan(0);
    expect(understanding.capabilities.every((capability) => capability.capabilityId.startsWith("cap-"))).toBe(true);
    expect(understanding.counts.nodes).toBe(280);
  });

  it("keeps every chunk id citable even when chunk text is trimmed", () => {
    expect(projected.payload.document.chunks.map((chunk) => chunk.chunkId))
      .toEqual(Array.from({ length: 12 }, (_, index) => `chunk-${index}`));
    expect(projected.payload.document.truncatedChunkCount).toBeGreaterThan(0);
    expect(JSON.stringify(projected)).not.toContain("boundingBox");
  });

  it("leaves a small navigate_and_extract result's chunk text untouched", () => {
    const result = {
      contractVersion: CONTRACT_MAJOR_VERSION,
      correlation: { requestId: "req-1", userId: "user-1" },
      toolCallId: "call-2",
      status: "success",
      payload: {
        metadata: { title: "Example", url: "https://example.com/a", language: "en", description: null, publishedTime: null, httpStatus: 200, contentType: null },
        chunks: [{ chunkId: "chunk-0", text: "The sky is blue.", startOffset: 0, endOffset: 17 }],
        warnings: [],
        truncations: [],
        timing: { navigationMs: 1, extractionMs: 1, totalMs: 2 },
        untrusted: true,
      },
      sensitivity: { sensitive: false, confirmationRequired: false },
    };
    const view = projectToolResultForModel(NAVIGATE_AND_EXTRACT_TOOL_NAME, result) as { payload: { chunks: Array<{ chunkId: string; text: string }> } };
    expect(view.payload.chunks).toEqual([{ chunkId: "chunk-0", text: "The sky is blue." }]);
  });

  it("returns an unrecognized or failed result unchanged", () => {
    const error = { status: "error", errorCode: "INTERNAL", message: "nope" };
    expect(projectToolResultForModel(EXPLORE_WEBSITE_TOOL_NAME, error)).toBe(error);
    expect(projectToolResultForModel("system.echo", error)).toBe(error);
  });
});

describe("elideOldToolResults", () => {
  function turns(): ConversationTurn[] {
    return [
      { role: "user", content: "compare these" },
      { role: "tool", content: JSON.stringify({ page: "a".repeat(20_000) }), toolCallId: "call-1", name: EXPLORE_WEBSITE_TOOL_NAME },
      { role: "tool", content: JSON.stringify({ page: "b".repeat(20_000) }), toolCallId: "call-2", name: EXPLORE_WEBSITE_TOOL_NAME },
      { role: "tool", content: JSON.stringify({ page: "c".repeat(20_000) }), toolCallId: "call-3", name: EXPLORE_WEBSITE_TOOL_NAME },
    ];
  }

  it("drops the oldest tool results first and always keeps the newest one", () => {
    const value = turns();
    const elided = elideOldToolResults(value, 6_000);
    expect(elided).toBe(2);
    expect(estimateTurnTokens(value)).toBeLessThan(6_000);
    expect(value[1]?.content).toContain("elided");
    expect(value[2]?.content).toContain("elided");
    expect(value[3]?.content).toContain("c".repeat(100));
  });

  it("leaves a turn that already fits the budget alone", () => {
    const value = turns();
    expect(elideOldToolResults(value, 100_000)).toBe(0);
    expect(value.every((turn) => !turn.content.includes("elided"))).toBe(true);
  });
});
