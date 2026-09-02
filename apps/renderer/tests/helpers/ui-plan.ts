import { UiPlanSchema, type UiPlan } from "@ai-browser/contracts";

/**
 * A minimal but fully valid `UiPlan`: one source, one collection, two
 * records, one fact, one media alternative, and a three-component tree.
 * Every test that needs a plan starts from this and mutates one thing, so a
 * failure points at the mutation rather than at fixture drift.
 */
export function validUiPlan(overrides: Partial<UiPlan> = {}): UiPlan {
  return UiPlanSchema.parse({
    schemaVersion: 1,
    canonicalGoal: "Compare two coffee grinders",
    sources: [
      {
        sourceId: "src-1",
        requestedUrl: "https://example.com/grinders",
        finalUrl: "https://example.com/grinders",
        origin: "https://example.com",
        title: "Grinder round-up",
        retrievedAt: "2026-09-02T10:00:00.000Z",
        captureStatus: "complete",
      },
    ],
    facts: [
      {
        factId: "fact-1",
        label: "Reviews considered",
        value: "42",
        kind: "count",
        unit: null,
        numericValue: 42,
        sourceId: "src-1",
        note: null,
      },
    ],
    collections: [
      { collectionId: "col-1", label: "Grinders", description: "Burr grinders under 300", comparableFieldRoles: ["price", "rating"] },
    ],
    records: [
      {
        recordId: "rec-1",
        collectionId: "col-1",
        title: "Grinder One",
        sourceId: "src-1",
        fields: [
          { fieldId: "f-1", label: "Price", value: "199", role: "price", numericValue: 199 },
          { fieldId: "f-2", label: "Rating", value: "4.5", role: "rating", numericValue: 4.5 },
        ],
        mediaIds: ["med-1"],
        factIds: ["fact-1"],
      },
      {
        recordId: "rec-2",
        collectionId: "col-1",
        title: "Grinder Two",
        sourceId: "src-1",
        fields: [
          { fieldId: "f-3", label: "Price", value: "249", role: "price", numericValue: 249 },
          { fieldId: "f-4", label: "Rating", value: "4.7", role: "rating", numericValue: 4.7 },
        ],
        mediaIds: [],
        factIds: [],
      },
    ],
    media: [
      { mediaId: "med-1", kind: "image", alternativeText: "Grinder One on a counter", caption: null, sourceId: "src-1" },
    ],
    components: [
      { componentId: "root", role: "root", label: "Grinder comparison", description: "Compare the grinders", childIds: ["summary", "table"], collectionId: null, recordIds: [], factIds: [], mediaIds: [] },
      { componentId: "summary", role: "summary", label: "Summary", description: "What was compared", childIds: [], collectionId: null, recordIds: [], factIds: ["fact-1"], mediaIds: ["med-1"] },
      { componentId: "table", role: "comparison_table", label: "Comparison", description: "Side by side", childIds: [], collectionId: "col-1", recordIds: ["rec-1", "rec-2"], factIds: [], mediaIds: [] },
    ],
    informationArchitecture: {
      primaryEntity: "Coffee grinder",
      grouping: "by_collection",
      ordering: "ascending",
      orderingFieldRole: "price",
      sectionIds: ["summary", "table"],
    },
    layout: { structure: "single_column", density: "comfortable", maxColumns: 2 },
    visualDirection: { tone: "product", accentToken: "accent", surfaceTokens: ["surface", "elevated"], emphasis: "Lead with price and rating" },
    typography: { headingLevels: 2, bodySizePx: 15, auxiliarySizePx: 13, monospaceFor: ["none"] },
    spacing: { baseUnitPx: 4, sectionGapPx: 24, itemGapPx: 12 },
    responsive: {
      breakpoints: [
        { name: "compact", minWidthPx: 800, columns: 1, collapse: ["summary"] },
        { name: "regular", minWidthPx: 1_024, columns: 2, collapse: [] },
      ],
      minimumViewport: { width: 800, height: 600 },
    },
    accessibility: {
      landmarks: ["main", "region"],
      headingOutline: [
        { level: 1, componentId: "root" },
        { level: 2, componentId: "table" },
      ],
      features: ["heading_order", "landmarks", "table_relationships", "visible_focus"],
      notes: [],
    },
    localInteractions: [
      {
        interactionId: "int-1",
        stateKey: "sortBy",
        kind: "sort",
        label: "Sort by",
        targetComponentId: "table",
        optionValues: ["price", "rating"],
        defaultValue: "price",
      },
    ],
    states: {
      empty: { headline: "Nothing to compare", body: "No grinders were found for this request." },
      loading: { headline: "Loading", body: "Preparing the comparison." },
      error: { headline: "Comparison unavailable", body: "The comparison could not be shown." },
      partial: { headline: "Partial results", body: "Some sources could not be read." },
    },
    coverage: { requestedSources: 1, capturedSources: 1, omissions: [], unsupportedRequests: [], confidence: "high" },
    constraints: { maxRecordsRendered: 50, maxComponentsRendered: 60, requireSourceAttribution: true, allowExternalActions: false, allowNetworkAccess: false },
    ...overrides,
  });
}
