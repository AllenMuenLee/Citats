import "server-only";

import {
  EXPLORE_WEBSITE_TOOL_NAME,
  ExploreWebsiteSuccessResultSchema,
  GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME,
  GetPageUnderstandingSliceSuccessResultSchema,
  NAVIGATE_AND_EXTRACT_TOOL_NAME,
  NavigateAndExtractSuccessResultSchema,
  type ExploreWebsiteSuccessResult,
  type PageNode,
  type PageUnderstanding,
} from "@ai-browser/contracts";
import type { ConversationTurn } from "../ai";

/**
 * A `browser.explore_website` result is bounded by contract, but its bounds
 * are generous: up to 50 document chunks of 8,000 characters each plus a
 * page-understanding graph of 400 nodes (2,000 characters of text apiece),
 * 800 relationships, 150 capabilities, and 40 source candidates. Serialized
 * whole, one such result is far larger than a per-minute token budget, and
 * the orchestrator re-sends every prior turn on *each* step of the loop
 * (the whole turn history is sent on every request, no provider-side
 * conversation state -- see `server/ai/streaming.ts`), so the cost is paid again
 * for every step and again for every later turn that still has the result in
 * history.
 *
 * The model never needs the whole graph to do its job. It needs chunk ids
 * and enough chunk text to cite, and it needs the handles that the tools it
 * may call actually accept: `observationId` and collection/region handles for
 * `browser.get_page_understanding_slice`. Node-level detail is exactly what
 * the slice tool exists to fetch on demand (see that tool's contract:
 * "instead of the whole graph being placed in every model turn").
 *
 * So the full result stays server-side -- evidence extraction, citation
 * resolution, and UI generation all keep reading it -- while only the
 * projection below is ever serialized into a model turn or persisted into
 * conversation history.
 */
export const MODEL_VIEW_LIMITS = Object.freeze({
  /** Characters of a single chunk's text handed to the model. */
  perChunkChars: 1_200,
  /** Characters of chunk text across one `browser.navigate_and_extract` result, whose chunks are the entire answer. */
  documentChunkChars: 12_000,
  /** Characters of chunk text across one `browser.explore_website` result, where the capability digest -- not the prose -- is the point. */
  exploreChunkChars: 6_000,
  /** Characters of chunk text once an info-model content digest carries the substance and chunks remain only for citation. */
  digestedChunkChars: 2_500,
  /** Floor on each chunk's share of that budget, so a chunk-heavy document still cites from end to end. */
  minChunkChars: 200,
  maxFieldRolesPerCollection: 12,
  maxRegions: 25,
  /** A plan may name at most ten local and ten external intents, so a longer capability list can never be referenced. */
  maxCapabilities: 20,
  maxCapabilityIntentChars: 100,
  maxWarnings: 10,
  maxWarningMessageChars: 160,
  maxCoverageNotes: 5,
  maxSliceNodes: 40,
  sliceNodeTextChars: 240,
});

const ELLIPSIS = "…";

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}${ELLIPSIS}` : value;
}

interface ProjectedChunk {
  chunkId: string;
  text: string;
}

interface ProjectedChunks {
  chunks: ProjectedChunk[];
  omittedChunkCount: number;
  truncatedChunkCount: number;
}

/**
 * Spends a fixed character budget on chunk text, shared evenly across the
 * document rather than first-come-first-served, so every chunk keeps a
 * citable head instead of the tail of the page falling out of context
 * entirely. A chunk whose text is cut still resolves citations normally:
 * `chunkId` is unchanged, and citation quote hashes are computed from the
 * full, server-held chunk.
 */
function projectChunks(chunks: ReadonlyArray<{ chunkId: string; text: string }>, totalChars: number): ProjectedChunks {
  const projected: ProjectedChunk[] = [];
  const share = chunks.length === 0
    ? MODEL_VIEW_LIMITS.perChunkChars
    : Math.min(MODEL_VIEW_LIMITS.perChunkChars, Math.max(MODEL_VIEW_LIMITS.minChunkChars, Math.floor(totalChars / chunks.length)));
  let used = 0;
  let omittedChunkCount = 0;
  let truncatedChunkCount = 0;
  for (const chunk of chunks) {
    const room = Math.min(share, totalChars - used);
    if (room <= 0) {
      omittedChunkCount += 1;
      continue;
    }
    const cut = chunk.text.length > room;
    if (cut) truncatedChunkCount += 1;
    used += cut ? room : chunk.text.length;
    projected.push({ chunkId: chunk.chunkId, text: cut ? `${chunk.text.slice(0, room)}${ELLIPSIS}` : chunk.text });
  }
  return { chunks: projected, omittedChunkCount, truncatedChunkCount };
}

function projectWarnings(warnings: ReadonlyArray<{ code: string; message: string }>): Array<{ code: string; message: string }> {
  return warnings
    .slice(0, MODEL_VIEW_LIMITS.maxWarnings)
    .map((warning) => ({ code: warning.code, message: clip(warning.message, MODEL_VIEW_LIMITS.maxWarningMessageChars) }));
}

/**
 * The compact stand-in for a whole `PageUnderstanding` graph: the identifiers
 * the plan/slice tools accept, what each collection can be bound to, and an
 * honest account of what was left out -- never the node list, relationship
 * list, bounding boxes, viewport state, or per-record field handles.
 */
function summarizePageUnderstanding(page: PageUnderstanding): Record<string, unknown> {
  const fieldRolesByCollection = new Map<string, Set<string>>();
  const actionCapabilityIds = new Set<string>();
  for (const candidate of page.sourceCandidates) {
    const roles = fieldRolesByCollection.get(candidate.collectionHandle) ?? new Set<string>();
    for (const field of candidate.fields) roles.add(field.role);
    fieldRolesByCollection.set(candidate.collectionHandle, roles);
    for (const id of candidate.actionCapabilityIds) actionCapabilityIds.add(id);
  }
  // Capabilities a source candidate already points at are the ones a plan can
  // realistically reference, so they keep their places in the budget first.
  const rankedCapabilities = [
    ...page.capabilities.filter((capability) => actionCapabilityIds.has(capability.capabilityId)),
    ...page.capabilities.filter((capability) => !actionCapabilityIds.has(capability.capabilityId)),
  ];
  const capabilities = rankedCapabilities.slice(0, MODEL_VIEW_LIMITS.maxCapabilities);
  const regions = page.regions.slice(0, MODEL_VIEW_LIMITS.maxRegions);
  return {
    observationId: page.observationId,
    status: page.status,
    url: page.metadata.finalUrl,
    title: page.metadata.title,
    description: page.metadata.description,
    language: page.metadata.language,
    collections: page.collections.map((collection) => ({
      handle: collection.handle,
      role: collection.role,
      itemCount: collection.itemCount,
      truncated: collection.truncated,
      fieldRoles: [...(fieldRolesByCollection.get(collection.handle) ?? [])].slice(0, MODEL_VIEW_LIMITS.maxFieldRolesPerCollection),
    })),
    regions: regions.map((region) => ({ handle: region.handle, role: region.role, label: region.label })),
    capabilities: capabilities.map((capability) => ({
      capabilityId: capability.capabilityId,
      kind: capability.capabilityKind,
      intent: clip(capability.semanticIntent, MODEL_VIEW_LIMITS.maxCapabilityIntentChars),
      effect: capability.effectClass,
    })),
    counts: {
      nodes: page.nodes.length,
      relationships: page.relationships.length,
      sourceCandidates: page.sourceCandidates.length,
      regionsOmitted: page.regions.length - regions.length,
      capabilitiesOmitted: page.capabilities.length - capabilities.length,
    },
    coverage: {
      observedControlCount: page.coverage.observedControlCount,
      inaccessibleRegionCount: page.coverage.inaccessibleRegionCount,
      unobservedLazyStateCount: page.coverage.unobservedLazyStateCount,
      notes: page.coverage.notes.slice(0, MODEL_VIEW_LIMITS.maxCoverageNotes),
    },
    warnings: projectWarnings(page.warnings),
    truncations: page.truncations,
    detail: `Node-level detail is not included. Call ${GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME} with this observationId and a collection or region handle when you need it.`,
    untrusted: true,
  };
}

function projectExplore(result: ExploreWebsiteSuccessResult, options: ProjectionOptions): Record<string, unknown> {
  const { document, pageUnderstanding } = result.payload;
  // With a digest attached, the chunks are no longer the model's only route to
  // the page's substance -- they stay only so a quote can still be cited.
  const chunks = projectChunks(document.chunks, options.digest ? MODEL_VIEW_LIMITS.digestedChunkChars : MODEL_VIEW_LIMITS.exploreChunkChars);
  return {
    status: "success",
    payload: {
      ...(options.digest ? { contentDigest: options.digest } : {}),
      document: {
        metadata: {
          url: document.metadata.url,
          title: document.metadata.title,
          description: document.metadata.description,
        },
        chunks: chunks.chunks,
        omittedChunkCount: chunks.omittedChunkCount,
        truncatedChunkCount: chunks.truncatedChunkCount,
        warnings: projectWarnings(document.warnings),
        truncations: document.truncations,
      },
      pageUnderstanding: summarizePageUnderstanding(pageUnderstanding),
      untrusted: true,
    },
  };
}

function projectNavigate(payload: {
  metadata: { url: string; title: string | null; description: string | null; httpStatus: number | null };
  chunks: ReadonlyArray<{ chunkId: string; text: string }>;
  warnings: ReadonlyArray<{ code: string; message: string }>;
  truncations: unknown;
}): Record<string, unknown> {
  const chunks = projectChunks(payload.chunks, MODEL_VIEW_LIMITS.documentChunkChars);
  return {
    status: "success",
    payload: {
      metadata: {
        url: payload.metadata.url,
        title: payload.metadata.title,
        description: payload.metadata.description,
        httpStatus: payload.metadata.httpStatus,
      },
      chunks: chunks.chunks,
      omittedChunkCount: chunks.omittedChunkCount,
      truncatedChunkCount: chunks.truncatedChunkCount,
      warnings: projectWarnings(payload.warnings),
      truncations: payload.truncations,
      untrusted: true,
    },
  };
}

/** Strips the layout facts (bounding boxes, visibility) the model cannot act on and caps node text. */
function projectSliceNode(node: PageNode): Record<string, unknown> {
  const { handle, kind } = node;
  const projected: Record<string, unknown> = { handle, kind };
  for (const [key, value] of Object.entries(node)) {
    if (key === "handle" || key === "kind" || key === "boundingBox" || key === "visibility") continue;
    projected[key] = typeof value === "string" ? clip(value, MODEL_VIEW_LIMITS.sliceNodeTextChars) : value;
  }
  return projected;
}

export interface ProjectionOptions {
  /**
   * The info model's content digest of this same observation, when one was
   * produced (see `observation-digest.ts`). Carries the record-level substance
   * the projection cannot mechanically select, so it is attached rather than
   * merged -- identifiers still come only from the exact projection.
   */
  digest?: unknown;
}

/**
 * Returns the value that is serialized into a model turn and persisted into
 * conversation history in place of `result`. Anything this does not
 * recognize -- an error result, a tool without a projection -- is returned
 * unchanged, so a tool result is never silently dropped.
 */
export function projectToolResultForModel(toolName: string, result: unknown, options: ProjectionOptions = {}): unknown {
  if (toolName === EXPLORE_WEBSITE_TOOL_NAME) {
    const parsed = ExploreWebsiteSuccessResultSchema.safeParse(result);
    return parsed.success ? projectExplore(parsed.data, options) : result;
  }
  if (toolName === NAVIGATE_AND_EXTRACT_TOOL_NAME) {
    const parsed = NavigateAndExtractSuccessResultSchema.safeParse(result);
    return parsed.success ? projectNavigate(parsed.data.payload) : result;
  }
  if (toolName === GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME) {
    const parsed = GetPageUnderstandingSliceSuccessResultSchema.safeParse(result);
    if (!parsed.success) return result;
    const { found, nodes, truncated, warnings } = parsed.data.payload;
    const kept = nodes.slice(0, MODEL_VIEW_LIMITS.maxSliceNodes);
    return {
      status: "success",
      payload: {
        found,
        nodes: kept.map(projectSliceNode),
        omittedNodeCount: nodes.length - kept.length,
        truncated,
        warnings: projectWarnings(warnings),
        untrusted: true,
      },
    };
  }
  return result;
}

/** Cheap, allocation-light stand-in for a tokenizer; four characters per token matches the conversation context estimator. */
export function estimateTurnTokens(turns: readonly ConversationTurn[]): number {
  let characters = 0;
  for (const turn of turns) {
    characters += turn.content.length;
    for (const call of turn.toolCalls ?? []) characters += call.name.length + call.arguments.length;
  }
  return Math.ceil(characters / 4);
}

const ELIDED_TOOL_RESULT = JSON.stringify({
  status: "elided",
  note: "This earlier tool result was dropped from context to stay within the request budget. Answer from the summary you already gave; do not repeat this call.",
});

/**
 * Bounds what one turn's tool loop can accumulate. Every step re-sends the
 * whole turn, so without this a long loop pays for each earlier tool result
 * once per remaining step. Oldest tool results are replaced by a stub first,
 * and the most recent one is always kept intact -- it is the result the model
 * is currently reasoning about.
 */
export function elideOldToolResults(turns: ConversationTurn[], maxTokens: number): number {
  let elided = 0;
  const toolIndexes = turns.flatMap((turn, index) => (turn.role === "tool" && turn.content !== ELIDED_TOOL_RESULT ? [index] : []));
  for (const index of toolIndexes.slice(0, -1)) {
    if (estimateTurnTokens(turns) <= maxTokens) break;
    turns[index] = { ...turns[index], content: ELIDED_TOOL_RESULT };
    elided += 1;
  }
  return elided;
}
