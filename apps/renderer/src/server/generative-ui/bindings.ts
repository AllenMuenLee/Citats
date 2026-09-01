import "server-only";

import type { PageNode, PageUnderstanding, UiSourceCandidate } from "@ai-browser/contracts";

/**
 * The one place goal-relevant records and media are selected from an
 * observation.
 *
 * Both the Phase 3 metadata artifact and the Phase 4 generation request
 * have to agree exactly on which record and media ids exist -- the request
 * schema rejects a binding the metadata does not declare -- so deriving
 * them twice from the same rule, in two files, would be a standing source
 * of drift. They derive them once, here.
 */
export type MediaNode = Extract<PageNode, { kind: "image" | "audio" | "video" | "svg_chart" }>;

export interface GoalRelevantBindings {
  readonly candidates: readonly UiSourceCandidate[];
  readonly recordIds: readonly string[];
  readonly nodeIds: ReadonlySet<string>;
  readonly collectionIds: ReadonlySet<string>;
  readonly mediaNodes: readonly MediaNode[];
  readonly mediaIds: readonly string[];
}

export function mediaBindingId(nodeHandle: string): string {
  return `media-${nodeHandle}`;
}

function isMediaNode(node: PageNode): node is MediaNode {
  return node.kind === "image" || node.kind === "audio" || node.kind === "video" || node.kind === "svg_chart";
}

/**
 * `collectionHandles` empty means "no collection was prioritized", which is
 * treated as every candidate rather than none -- a plan that omits the
 * prioritization should still render the page's records.
 */
export function selectGoalRelevantBindings(
  page: PageUnderstanding,
  collectionHandles: readonly string[],
): GoalRelevantBindings {
  const selected = new Set(collectionHandles);
  const candidates = page.sourceCandidates.filter(
    (candidate) => selected.size === 0 || selected.has(candidate.collectionHandle),
  );
  const recordIds = [...new Set(candidates.flatMap((candidate) => (candidate.recordHandle ? [candidate.recordHandle] : [])))];
  const nodeIds = new Set(candidates.flatMap((candidate) => candidate.fields.map((field) => field.nodeHandle)));
  for (const recordId of recordIds) nodeIds.add(recordId);
  const mediaNodes = page.nodes.filter((node): node is MediaNode => nodeIds.has(node.handle) && isMediaNode(node));
  return {
    candidates,
    recordIds,
    nodeIds,
    collectionIds: new Set(candidates.map((candidate) => candidate.collectionHandle)),
    mediaNodes,
    mediaIds: mediaNodes.map((node) => mediaBindingId(node.handle)),
  };
}
