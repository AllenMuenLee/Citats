import type { PageUnderstanding, UiCapabilityBinding, UiGenerationBrief, UiGenerationRequest } from "@ai-browser/contracts";
import { mediaBindingId, selectGoalRelevantBindings } from "./bindings";
import { UI_GENERATION_PROMPT_DIGEST, UI_GENERATION_PROMPT_VERSION } from "./system-prompt";

export const GENERATED_UI_RUNTIME_API_VERSION = "1.0.0";

const COMMAND_KINDS_BY_CAPABILITY_KIND: Readonly<Record<string, UiCapabilityBinding["allowedCommandKinds"]>> = {
  media_control: ["media_control"],
  local_view_change: ["select"],
};

/**
 * Builds the closed Phase 4 generation request from the validated Phase 3
 * brief. The brief's `WebsiteUiMetadata` is the authority on which
 * capabilities exist and how each one may run, so bindings are derived from
 * it rather than re-classified here -- `UiGenerationRequestSchema` rejects
 * any binding the metadata does not declare.
 */
export function buildUiGenerationRequest(input: {
  task: string;
  brief: UiGenerationBrief;
  page: PageUnderstanding;
  requestId: string;
  userId: string;
}): UiGenerationRequest {
  const { brief, page } = input;
  const bindings = selectGoalRelevantBindings(page, brief.prioritizedCollectionHandles);
  const capabilityById = new Map(page.capabilities.map((capability) => [capability.capabilityId, capability]));
  const declared = [
    ...brief.metadata.internalInteractions.map((item) => item.capabilityId),
    ...brief.metadata.externalCapabilities.map((item) => item.capabilityId),
  ];
  const capabilityBindings: UiCapabilityBinding[] = [];
  for (const capabilityId of declared) {
    const capability = capabilityById.get(capabilityId);
    if (!capability) continue;
    capabilityBindings.push({
      capabilityId,
      capability,
      allowedCommandKinds: COMMAND_KINDS_BY_CAPABILITY_KIND[capability.capabilityKind] ?? ["activate"],
      argumentSchemaId: `args-${capabilityId}`,
      interactionExecution: capability.interactionExecution,
      promptTemplateId: capability.promptTemplateId,
    });
  }
  const controlHandles = new Set(capabilityBindings.map((binding) => binding.capability.controlHandle));
  const origin = page.metadata.origin || new URL(page.metadata.finalUrl).origin;
  const recordIds = new Set(brief.metadata.recordIds);
  const mediaIds = new Set(brief.metadata.mediaIds);

  return {
    schemaVersion: 1,
    promptVersion: UI_GENERATION_PROMPT_VERSION,
    promptDigest: UI_GENERATION_PROMPT_DIGEST,
    canonicalUserTask: input.task.trim(),
    brief,
    implementationPrompt: brief.implementationPrompt,
    websiteUiMetadata: brief.metadata,
    websiteUiMetadataDigest: brief.metadataDigest,
    graph: {
      nodes: page.nodes.filter((node) => bindings.nodeIds.has(node.handle) || controlHandles.has(node.handle)),
      relationships: page.relationships.filter((relationship) => bindings.nodeIds.has(relationship.from) && bindings.nodeIds.has(relationship.to)),
      regions: page.regions.filter((region) => brief.detailRegionHandles.includes(region.handle)),
      collections: page.collections.filter((collection) => bindings.collectionIds.has(collection.handle)),
    },
    sourceBindings: bindings.candidates.map((candidate, index) => ({
      sourceId: `source-${index + 1}`,
      candidate,
      provider: origin,
      displayLabel: page.metadata.title ?? origin,
    })),
    recordBindings: bindings.candidates
      .filter((candidate) => candidate.recordHandle !== null && recordIds.has(candidate.recordHandle))
      .map((candidate) => ({
        recordId: candidate.recordHandle!,
        collectionId: candidate.collectionHandle,
        fieldNodeIds: candidate.fields.map((field) => field.nodeHandle),
      })),
    mediaBindings: bindings.mediaNodes
      .filter((node) => mediaIds.has(mediaBindingId(node.handle)))
      .map((node) => ({
        mediaId: mediaBindingId(node.handle),
        nodeId: node.handle,
        kind: node.kind === "svg_chart" ? "chart" : node.kind,
        altText: ("altText" in node ? node.altText : "title" in node ? node.title : "label" in node ? node.label : null) ?? "Media",
        safeReference: `media-ref-${node.handle}`,
      })),
    capabilityBindings,
    coverage: page.coverage,
    freshness: brief.freshness,
    warnings: page.warnings,
    runtimeApiVersion: GENERATED_UI_RUNTIME_API_VERSION,
    theme: {
      allowedTokens: ["canvas", "surface", "elevated", "text-primary", "text-secondary", "border", "accent", "accent-hover", "success", "warning", "danger", "focus", "space-4", "space-8", "space-12", "space-16", "space-24", "space-32", "radius-control", "radius-panel", "radius-overlay"],
      minimumTargetSize: 40,
      supportedThemes: ["light", "dark"],
      supportsReducedMotion: true,
      minimumViewport: { width: 800, height: 600 },
      maximumZoomPercent: 200,
    },
    limits: { maxSourceBytes: 65_536, maxAstNodes: 20_000, maxComplexity: 200, maxRenderNodes: 5_000, maxLocalStateEntries: 32 },
    correlation: { requestId: input.requestId, userId: input.userId },
  };
}
