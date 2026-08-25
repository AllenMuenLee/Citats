import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_PAGE_NODES, PageNodeSchema, PageUnderstandingSchema } from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function validGraph(): Record<string, any> {
  const result = JSON.parse(readFileSync(join(fixtures, "success-result-explore-website", "valid-1.json"), "utf8"));
  return structuredClone(result.payload.pageUnderstanding);
}

describe("PageUnderstanding canonical graph", () => {
  it("round-trips the cross-language fixture", () => {
    const graph = validGraph();
    expect(PageUnderstandingSchema.parse(JSON.parse(JSON.stringify(graph)))).toEqual(graph);
  });

  it("retains an explicit unknown semantic node without accepting arbitrary fields", () => {
    const node = { kind: "unknown", handle: "node-unknown", boundingBox: null, visibility: "visible", tagName: "x-card", observedRole: null };
    expect(PageNodeSchema.parse(node)).toEqual(node);
    expect(PageNodeSchema.safeParse({ ...node, selector: "#secret" }).success).toBe(false);
  });

  it("rejects duplicate and dangling node references", () => {
    const duplicate = validGraph();
    duplicate.nodes.push(structuredClone(duplicate.nodes[0]));
    expect(PageUnderstandingSchema.safeParse(duplicate).success).toBe(false);

    const dangling = validGraph();
    dangling.relationships[0].to = "node-missing";
    expect(PageUnderstandingSchema.safeParse(dangling).success).toBe(false);
  });

  it("rejects cycles in hierarchical and reading-order edges", () => {
    for (const kind of ["parent_child", "reading_order"]) {
      const graph = validGraph();
      graph.relationships = [
        { kind, from: "node-main", to: "node-result-1", order: null },
        { kind, from: "node-result-1", to: "node-main", order: null },
      ];
      expect(PageUnderstandingSchema.safeParse(graph).success).toBe(false);
    }
  });

  it("enforces repeated-record ownership and omission accounting", () => {
    const wrongOwner = validGraph();
    wrongOwner.nodes[1].collectionHandle = "collection-missing";
    expect(PageUnderstandingSchema.safeParse(wrongOwner).success).toBe(false);

    const silentTruncation = validGraph();
    silentTruncation.collections[0].truncated = true;
    expect(PageUnderstandingSchema.safeParse(silentTruncation).success).toBe(false);
    silentTruncation.truncations.push({ category: "collections", reason: "bounded", removedCount: 11 });
    expect(PageUnderstandingSchema.safeParse(silentTruncation).success).toBe(true);
  });

  it("rejects graphs beyond the node payload bound", () => {
    const graph = validGraph();
    graph.nodes = Array.from({ length: MAX_PAGE_NODES + 1 }, (_, index) => ({
      kind: "unknown",
      handle: `node-${index}`,
      boundingBox: null,
      visibility: "visible",
      tagName: null,
      observedRole: null,
    }));
    graph.relationships = [];
    graph.regions = [];
    graph.collections = [];
    graph.sourceCandidates = [];
    expect(PageUnderstandingSchema.safeParse(graph).success).toBe(false);
  });
});
