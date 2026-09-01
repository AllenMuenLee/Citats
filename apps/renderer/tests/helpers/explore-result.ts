import {
  CONTRACT_MAJOR_VERSION,
  ExploreWebsiteSuccessResultSchema,
  DEFAULT_CONTROL_STATE,
  type ExploreWebsiteSuccessResult,
  type InteractionCapability,
  type PageNode,
  type PageRelationship,
  type UiSourceCandidate,
} from "@ai-browser/contracts";

export const RECORDS_PER_COLLECTION = 20;
const FIELDS_PER_RECORD = 5;

/**
 * Shape overrides for one built observation. Defaults reproduce the
 * original mid-sized fixture exactly, so every existing caller is
 * unaffected; P03-R06 uses them to build the six-record accommodation
 * results page and its partial-coverage variant.
 */
export interface ExploreResultOptions {
  recordsPerCollection?: number;
  collectionHandles?: readonly string[];
  finalUrl?: string;
  status?: "complete" | "partial" | "timeout" | "unstable";
  warnings?: readonly { code: string; message: string; nodeHandle: string | null }[];
  truncations?: readonly { reason: string; category: string; removedCount: number }[];
  inaccessibleRegionCount?: number;
  coverageNotes?: readonly string[];
}

/**
 * A mid-sized -- not worst-case -- observation of a search-results page: two
 * collections of twenty records, five bound fields each, forty controls, ten
 * regions, and a dozen document chunks. The contract permits roughly four
 * times this (400 nodes, 800 relationships, 50 chunks of 8,000 characters),
 * so the reduction measured against this fixture is a conservative floor.
 */
export function buildExploreResult(options: ExploreResultOptions = {}): ExploreWebsiteSuccessResult {
  const recordsPerCollection = options.recordsPerCollection ?? RECORDS_PER_COLLECTION;
  const nodes: PageNode[] = [];
  const relationships: PageRelationship[] = [];
  const capabilities: InteractionCapability[] = [];
  const sourceCandidates: UiSourceCandidate[] = [];
  const collections = [...(options.collectionHandles ?? ["col-search-results", "col-related-items"])];
  const finalUrl = options.finalUrl ?? "https://example.com/s/seattle";
  const origin = new URL(finalUrl).origin;

  for (const [collectionIndex, collectionHandle] of collections.entries()) {
    for (let record = 0; record < recordsPerCollection; record += 1) {
      const recordHandle = `rec-${collectionIndex}-${record}`;
      const controlHandle = `ctl-${collectionIndex}-${record}`;
      const capabilityId = `cap-${collectionIndex}-${record}`;
      nodes.push({
        kind: "repeated_record",
        handle: recordHandle,
        boundingBox: { x: 12.5, y: 120 + record * 96, width: 640, height: 88 },
        visibility: "visible",
        role: "listing",
        collectionHandle,
        index: record,
      });
      nodes.push({
        kind: "control",
        handle: controlHandle,
        boundingBox: { x: 560.25, y: 130 + record * 96, width: 72, height: 32 },
        visibility: "visible",
        role: "button",
        label: `Save listing ${record}`,
        state: DEFAULT_CONTROL_STATE,
      });
      const fieldHandles: string[] = [];
      for (let field = 0; field < FIELDS_PER_RECORD; field += 1) {
        const nodeHandle = `txt-${collectionIndex}-${record}-${field}`;
        fieldHandles.push(nodeHandle);
        nodes.push({
          kind: "text",
          handle: nodeHandle,
          boundingBox: { x: 24, y: 132 + record * 96 + field * 14, width: 480, height: 14 },
          visibility: "visible",
          role: field === 0 ? "heading" : field === 3 ? "price" : "paragraph",
          text: `Entire loft in the harbour district, sleeps ${field + 2}, ${180 + record * 7} per night, rated ${(4 + field / 10).toFixed(1)} across ${40 + record} reviews.`,
          headingLevel: field === 0 ? 3 : null,
        });
        relationships.push({ kind: "record_field", from: recordHandle, to: nodeHandle, order: field });
      }
      relationships.push({ kind: "record_action", from: recordHandle, to: controlHandle, order: null });
      // Every other record's control is external, so a fixture exercises
      // both the React-only path and the AI-action path.
      const external = record % 2 === 1;
      capabilities.push({
        capabilityId,
        semanticIntent: external
          ? `Book listing ${record} of the ${collectionHandle} collection`
          : `Save listing ${record} of the ${collectionHandle} collection to a shortlist`,
        controlHandle,
        owningHandle: recordHandle,
        capabilityKind: external ? "reservation_purchase_payment" : "local_view_change",
        state: DEFAULT_CONTROL_STATE,
        requiredInputs: [],
        destinationOrigin: external ? "https://example.com" : null,
        effectClass: external ? "submission" : "local_view",
        interactionExecution: external ? "external_ai_action" : "internal_react",
        promptTemplateId: external ? `tpl-${collectionIndex}-${record}` : null,
        promptTemplate: external
          ? "Start the booking for the selected listing {{selection}} and wait for the user to confirm."
          : null,
        argumentSchema: external ? [{ name: "selection", type: "string", required: true, values: null }] : [],
        confidence: 0.82,
        evidence: [{ kind: "dom_node", nodeHandle: controlHandle }, { kind: "accessibility_state" }],
        requiredCapability: "action_execution",
      });
      sourceCandidates.push({
        collectionHandle,
        recordHandle,
        fields: fieldHandles.map((nodeHandle, index) => ({
          role: (["title", "description", "image", "price", "rating"] as const)[index]!,
          nodeHandle,
          confidence: 0.7 + index / 100,
        })),
        actionCapabilityIds: [capabilityId],
      });
    }
  }

  const regions = Array.from({ length: 10 }, (_, index) => ({
    handle: `reg-${index}`,
    role: index === 0 ? "main" : "region",
    label: `Results section ${index}`,
    childHandles: nodes.filter((node) => node.kind === "repeated_record").slice(0, 4).map((node) => node.handle),
  }));

  return ExploreWebsiteSuccessResultSchema.parse({
    contractVersion: CONTRACT_MAJOR_VERSION,
    correlation: { requestId: "req-1", userId: "user-1" },
    toolCallId: "call-1",
    status: "success",
    payload: {
      document: {
        metadata: {
          title: "Stays in Seattle",
          url: finalUrl,
          origin,
          language: "en",
          description: "Search results",
          author: null,
          publishedTime: null,
          updatedTime: null,
          siteName: "Example Stays",
          pageType: "website",
          imageUrl: null,
          httpStatus: 200,
          contentType: "text/html",
        },
        accessibility: [
          { nodeId: "ax-1", parentId: null, role: "heading", name: "Stays in Seattle", description: null, value: null, states: { level: "1" }, domTag: "h1", correlated: true },
          { nodeId: "ax-2", parentId: "ax-1", role: "button", name: "Book", description: null, value: null, states: { disabled: false }, domTag: "button", correlated: true },
        ],
        chunks: Array.from({ length: 12 }, (_, index) => ({
          chunkId: `chunk-${index}`,
          text: `Listing block ${index}. `.repeat(150),
          startOffset: index * 3_000,
          endOffset: (index + 1) * 3_000,
        })),
        warnings: [],
        truncations: [],
      },
      pageUnderstanding: {
        schemaVersion: 1,
        observationId: "obs-1",
        metadata: {
          finalUrl,
          origin,
          title: "Stays in Seattle",
          language: "en",
          description: "Search results",
          author: null,
          publishedTime: null,
          updatedTime: null,
          favicon: null,
          themeColor: null,
          viewportHint: null,
          documentDirection: "ltr",
          contentType: "text/html",
          charset: "utf-8",
          robots: null,
        },
        status: options.status ?? "complete",
        nodes,
        relationships,
        regions,
        collections: collections.map((handle, index) => ({
          handle,
          role: index === 0 ? "search_results" : "generic_records",
          itemCount: recordsPerCollection,
          recordHandles: Array.from({ length: recordsPerCollection }, (_, record) => `rec-${index}-${record}`),
          truncated: false,
          paginationHandle: null,
        })),
        capabilities,
        sourceCandidates,
        viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 4_800, devicePixelRatio: 2 },
        warnings: options.warnings ?? [],
        truncations: options.truncations ?? [],
        coverage: {
          observedControlCount: 40,
          safelyExploredControlCount: 40,
          prohibitedControlCount: 0,
          unknownControlCount: 0,
          inaccessibleRegionCount: options.inaccessibleRegionCount ?? 0,
          unobservedLazyStateCount: 1,
          notes: options.coverageNotes
            ? [...options.coverageNotes]
            : ["Lazy-loaded results below the fold were not observed."],
        },
        observationDigest: "digest-1",
        untrusted: true,
      },
      timing: { navigationMs: 900, extractionMs: 120, observationMs: 240, totalMs: 1_260 },
      untrusted: true,
    },
    sensitivity: { sensitive: false, confirmationRequired: false },
  });
}
