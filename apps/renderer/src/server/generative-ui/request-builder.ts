import type { GenerativeUiPlan, PageUnderstanding, UiGenerationRequest } from "@ai-browser/contracts";
import { UI_GENERATION_PROMPT_DIGEST, UI_GENERATION_PROMPT_VERSION } from "./system-prompt";

export const GENERATED_UI_RUNTIME_API_VERSION = "1.0.0";

export function buildUiGenerationRequest(input: { task: string; plan: GenerativeUiPlan; page: PageUnderstanding; requestId: string; userId: string }): UiGenerationRequest {
  const selectedCollections = new Set(input.plan.sourceCollectionHandles);
  const candidates = input.page.sourceCandidates.filter((candidate) => selectedCollections.size === 0 || selectedCollections.has(candidate.collectionHandle));
  const recordIds = new Set(candidates.flatMap((candidate) => candidate.recordHandle ? [candidate.recordHandle] : []));
  const nodeIds = new Set(candidates.flatMap((candidate) => candidate.fields.map((field) => field.nodeHandle)));
  for (const recordId of recordIds) nodeIds.add(recordId);
  const collectionIds = new Set(candidates.map((candidate) => candidate.collectionHandle));
  const capabilityIds = new Set([...input.plan.localInteractionIntents, ...input.plan.externalWorkflowIntents]);
  const capabilities = input.page.capabilities.filter((capability) => capabilityIds.has(capability.capabilityId));
  const mediaNodes = input.page.nodes.filter((node): node is Extract<typeof node, { kind: "image" | "audio" | "video" | "svg_chart" }> => nodeIds.has(node.handle) && (node.kind === "image" || node.kind === "audio" || node.kind === "video" || node.kind === "svg_chart"));
  const origin = input.page.metadata.origin || new URL(input.page.metadata.finalUrl).origin;
  return {
    schemaVersion: 1,
    promptVersion: UI_GENERATION_PROMPT_VERSION,
    promptDigest: UI_GENERATION_PROMPT_DIGEST,
    canonicalUserTask: input.task.trim(),
    brief: input.plan,
    graph: {
      nodes: input.page.nodes.filter((node) => nodeIds.has(node.handle) || capabilities.some((capability) => capability.controlHandle === node.handle)),
      relationships: input.page.relationships.filter((relationship) => nodeIds.has(relationship.from) && nodeIds.has(relationship.to)),
      regions: input.page.regions.filter((region) => input.plan.detailRegionHandles.includes(region.handle)),
      collections: input.page.collections.filter((collection) => collectionIds.has(collection.handle)),
    },
    sourceBindings: candidates.map((candidate, index) => ({ sourceId: `source-${index + 1}`, candidate, provider: origin, displayLabel: input.page.metadata.title ?? origin })),
    recordBindings: [...recordIds].map((recordId) => ({ recordId, collectionId: candidates.find((candidate) => candidate.recordHandle === recordId)!.collectionHandle, fieldNodeIds: candidates.find((candidate) => candidate.recordHandle === recordId)!.fields.map((field) => field.nodeHandle) })),
    mediaBindings: mediaNodes.map((node) => ({ mediaId: `media-${node.handle}`, nodeId: node.handle, kind: node.kind === "svg_chart" ? "chart" : node.kind, altText: ("altText" in node ? node.altText : "title" in node ? node.title : "label" in node ? node.label : null) ?? "Media", safeReference: `media-ref-${node.handle}` })),
    capabilityBindings: capabilities.map((capability) => ({ capabilityId: capability.capabilityId, capability, allowedCommandKinds: capability.capabilityKind === "media_control" ? ["media_control"] : capability.capabilityKind === "local_view_change" ? ["select"] : ["activate"], argumentSchemaId: `args-${capability.capabilityId}` })),
    coverage: input.page.coverage,
    freshness: input.plan.freshness,
    warnings: input.page.warnings,
    runtimeApiVersion: GENERATED_UI_RUNTIME_API_VERSION,
    theme: { allowedTokens: ["canvas", "surface", "elevated", "text-primary", "text-secondary", "border", "accent", "accent-hover", "success", "warning", "danger", "focus", "space-4", "space-8", "space-12", "space-16", "space-24", "space-32", "radius-control", "radius-panel", "radius-overlay"], minimumTargetSize: 40, supportedThemes: ["light", "dark"], supportsReducedMotion: true, minimumViewport: { width: 800, height: 600 }, maximumZoomPercent: 200 },
    limits: { maxSourceBytes: 65_536, maxAstNodes: 20_000, maxComplexity: 200, maxRenderNodes: 5_000, maxLocalStateEntries: 32 },
    correlation: { requestId: input.requestId, userId: input.userId },
  };
}
