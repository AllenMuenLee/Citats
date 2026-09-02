import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * `UiPlan` -- the closed, versioned plan the UI planning model produces
 * (Phase 3, P03-F03) and the UI model consumes (Phase 4).
 *
 * It is the *only* thing the UI model ever sees of the captured websites.
 * Rendered HTML never leaves the capture stage, so everything the generated
 * component may show has to survive into this shape first: the goal, the
 * source identities it came from, the facts and records with provenance,
 * the media and their alternatives, and the whole design brief (hierarchy,
 * information architecture, layout, visual direction, typography, spacing,
 * responsive behaviour, accessibility, local interactions, and the
 * empty/loading/error/partial states).
 *
 * Two rules shape every schema below:
 *
 *  - **Local interactions only.** A plan may describe selecting, filtering,
 *    sorting, expanding, tabbing, and gallery/modal state over data it
 *    already supplies. It may not describe an external action, an API, a
 *    navigation, a selector, an executable URL, a credential, or any code.
 *    There is no field capable of carrying one, and `planText` rejects the
 *    syntax of one in every free-text field.
 *  - **Every reference resolves.** Facts, records, media, and components
 *    address each other by opaque plan ids, and `UiPlanSchema` fails a plan
 *    whose ids do not all resolve against the plan's own sources. The
 *    planner cannot smuggle in an id that no capture supported.
 */

export const UI_PLAN_SCHEMA_VERSION = 1 as const;

export const PLAN_ID_MAX_LENGTH = 64;

/**
 * Opaque, stable, plan-scoped identifier. Deliberately narrower than the
 * page-understanding handle shape: a plan id is minted by the planning
 * stage for this one plan and is never a lookup key into anything outside
 * it, so it carries no punctuation that could read as a path or a scheme.
 */
export const PlanIdSchema = z
  .string()
  .min(1)
  .max(PLAN_ID_MAX_LENGTH)
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/, "must be a lowercase opaque plan id");

const CODE_LIKE = [
  /<\s*\/?\s*[a-z][a-z0-9]*[\s/>]/iu,
  /<\s*(?:script|style|iframe|object|embed|link|meta)\b/iu,
  /\b(?:javascript|vbscript|data|file|blob|about|chrome|chrome-extension|ms-appx|resource)\s*:/iu,
  /\bon[a-z]{3,}\s*=/iu,
  /\{\{|\}\}|\$\{/u,
  /\b(?:eval|new\s+Function|import\s*\(|require\s*\()/u,
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u,
] as const;

/**
 * Free text inside a plan is display copy, never markup and never a
 * reference to something executable. This is the single gate every label,
 * description, and value passes through, so the UI model can be told
 * "render plan text verbatim" without that becoming an injection path into
 * the generated component or, through it, the sandbox.
 */
export function planText(max: number, min = 0): z.ZodType<string> {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .superRefine((value, ctx) => {
      for (const pattern of CODE_LIKE) {
        if (pattern.test(value)) {
          ctx.addIssue({ code: "custom", message: "plan text must not contain markup, code, or a URL scheme" });
          return;
        }
      }
    });
}

export const PlanTextSchema = planText(2_000);
export const PlanLabelSchema = planText(160, 1);
export const PlanShortTextSchema = planText(600);

/**
 * A source URL is kept as *identity and provenance* -- what the reader is
 * being shown the provenance of -- not as something to fetch or link to.
 * The sandbox has no network and no navigation, so these only ever render
 * as text.
 */
const PlanUrlSchema = z
  .string()
  .max(2_048)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be an absolute URL" });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "URL scheme must be 'http' or 'https'" });
    }
    if (parsed.username || parsed.password) {
      ctx.addIssue({ code: "custom", message: "URL must not carry credentials" });
    }
  });

export const MAX_PLAN_SOURCES = 12;
export const MAX_PLAN_FACTS = 200;
export const MAX_PLAN_RECORDS = 200;
export const MAX_PLAN_COLLECTIONS = 12;
export const MAX_PLAN_RECORD_FIELDS = 24;
export const MAX_PLAN_MEDIA = 200;
export const MAX_PLAN_COMPONENTS = 120;
export const MAX_PLAN_INTERACTIONS = 24;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const UiPlanSourceSchema = z
  .object({
    sourceId: PlanIdSchema,
    /** The normalized URL the capture loop was told to open. */
    requestedUrl: PlanUrlSchema,
    /** Where it actually ended up after redirects -- re-validated in trusted code. */
    finalUrl: PlanUrlSchema,
    origin: planText(253, 1),
    title: PlanLabelSchema,
    retrievedAt: z.iso.datetime({ offset: true }),
    /** Whether this capture was complete or was bounded/truncated on the way in. */
    captureStatus: z.enum(["complete", "truncated", "partial"]),
  })
  .strict();

export type UiPlanSource = z.infer<typeof UiPlanSourceSchema>;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export const UiPlanFactKindSchema = z.enum([
  "text",
  "number",
  "money",
  "percentage",
  "date",
  "duration",
  "rating",
  "count",
  "boolean",
]);

/**
 * One task-relevant statement lifted out of a capture. `sourceId` is
 * mandatory: a plan cannot state a fact it cannot attribute, which is what
 * makes "no unsupported facts" checkable rather than a request.
 */
export const UiPlanFactSchema = z
  .object({
    factId: PlanIdSchema,
    label: PlanLabelSchema,
    value: planText(600, 1),
    kind: UiPlanFactKindSchema,
    unit: planText(24).nullable(),
    /** Parsed numeric form when one exists, so the component can sort/compare without re-parsing display text. */
    numericValue: z.number().finite().nullable(),
    sourceId: PlanIdSchema,
    note: PlanShortTextSchema.nullable(),
  })
  .strict();

export type UiPlanFact = z.infer<typeof UiPlanFactSchema>;

export const UiPlanFieldRoleSchema = z.enum([
  "title",
  "subtitle",
  "price",
  "rating",
  "date",
  "time",
  "duration",
  "location",
  "description",
  "category",
  "quantity",
  "availability",
  "identifier",
  "attribution",
  "other",
]);

export const UiPlanRecordFieldSchema = z
  .object({
    fieldId: PlanIdSchema,
    label: PlanLabelSchema,
    value: planText(1_200),
    role: UiPlanFieldRoleSchema,
    /** Comparable form for sorting/filtering; `null` when the field is not orderable. */
    numericValue: z.number().finite().nullable(),
  })
  .strict();

export const UiPlanRecordSchema = z
  .object({
    recordId: PlanIdSchema,
    collectionId: PlanIdSchema,
    title: PlanLabelSchema,
    sourceId: PlanIdSchema,
    fields: z.array(UiPlanRecordFieldSchema).min(1).max(MAX_PLAN_RECORD_FIELDS),
    mediaIds: z.array(PlanIdSchema).max(8),
    factIds: z.array(PlanIdSchema).max(16),
  })
  .strict();

export type UiPlanRecord = z.infer<typeof UiPlanRecordSchema>;

export const UiPlanCollectionSchema = z
  .object({
    collectionId: PlanIdSchema,
    label: PlanLabelSchema,
    description: PlanShortTextSchema,
    /** Field roles present on enough records to be worth comparing across them. */
    comparableFieldRoles: z.array(UiPlanFieldRoleSchema).max(12),
  })
  .strict();

/**
 * Media is described, never fetched. The sandbox has no network, so a plan
 * carries the *alternative* -- the accessible description and a caption --
 * and the generated component renders a labelled placeholder. This is the
 * "media and alternatives" requirement discharged in the only way an
 * offline, network-denied surface can discharge it.
 */
export const UiPlanMediaSchema = z
  .object({
    mediaId: PlanIdSchema,
    kind: z.enum(["image", "illustration", "chart", "video", "audio", "icon"]),
    alternativeText: planText(500, 1),
    caption: PlanShortTextSchema.nullable(),
    sourceId: PlanIdSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Design brief
// ---------------------------------------------------------------------------

export const UiPlanComponentRoleSchema = z.enum([
  "root",
  "header",
  "summary",
  "toolbar",
  "section",
  "list",
  "grid",
  "table",
  "comparison_table",
  "card",
  "detail_panel",
  "gallery",
  "timeline",
  "schedule",
  "stat_row",
  "article_body",
  "callout",
  "footnote",
  "empty_state",
]);

export const UiPlanComponentSchema = z
  .object({
    componentId: PlanIdSchema,
    role: UiPlanComponentRoleSchema,
    label: PlanLabelSchema,
    description: PlanShortTextSchema,
    childIds: z.array(PlanIdSchema).max(32),
    collectionId: PlanIdSchema.nullable(),
    recordIds: z.array(PlanIdSchema).max(MAX_PLAN_RECORDS),
    factIds: z.array(PlanIdSchema).max(MAX_PLAN_FACTS),
    mediaIds: z.array(PlanIdSchema).max(32),
  })
  .strict();

export type UiPlanComponent = z.infer<typeof UiPlanComponentSchema>;

export const UiPlanInformationArchitectureSchema = z
  .object({
    primaryEntity: PlanLabelSchema,
    grouping: z.enum(["none", "by_collection", "by_source", "by_category", "by_date"]),
    ordering: z.enum(["source_order", "ascending", "descending", "alphabetical", "chronological"]),
    orderingFieldRole: UiPlanFieldRoleSchema.nullable(),
    /** Top-level components, in reading order. */
    sectionIds: z.array(PlanIdSchema).min(1).max(24),
  })
  .strict();

export const UiPlanLayoutSchema = z
  .object({
    structure: z.enum(["single_column", "two_column", "grid", "table", "split_detail"]),
    density: z.enum(["compact", "comfortable", "spacious"]),
    /** Column count at the widest supported breakpoint. */
    maxColumns: z.number().int().min(1).max(6),
  })
  .strict();

export const UiPlanVisualDirectionSchema = z
  .object({
    tone: z.enum(["neutral", "editorial", "data_dense", "product", "media_rich", "utility"]),
    /** Semantic tokens only -- never a raw color. Checked against the theme constraints at generation time. */
    accentToken: planText(60, 1),
    surfaceTokens: z.array(planText(60, 1)).min(1).max(12),
    emphasis: PlanShortTextSchema,
  })
  .strict();

export const UiPlanTypographySchema = z
  .object({
    headingLevels: z.number().int().min(1).max(4),
    bodySizePx: z.number().int().min(12).max(18),
    auxiliarySizePx: z.number().int().min(12).max(16),
    monospaceFor: z.array(z.enum(["identifier", "url", "code", "none"])).max(4),
  })
  .strict();

export const UiPlanSpacingSchema = z
  .object({
    baseUnitPx: z.literal(4),
    sectionGapPx: z.number().int().min(8).max(48),
    itemGapPx: z.number().int().min(4).max(32),
  })
  .strict();

export const UiPlanResponsiveSchema = z
  .object({
    breakpoints: z
      .array(
        z
          .object({
            name: z.enum(["compact", "regular", "wide"]),
            minWidthPx: z.number().int().min(320).max(2_560),
            columns: z.number().int().min(1).max(6),
            collapse: z.array(PlanIdSchema).max(16),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    minimumViewport: z.object({ width: z.literal(800), height: z.literal(600) }).strict(),
  })
  .strict();

export const UiPlanAccessibilitySchema = z
  .object({
    landmarks: z.array(z.enum(["main", "region", "navigation", "complementary", "contentinfo"])).min(1).max(6),
    headingOutline: z
      .array(z.object({ level: z.number().int().min(1).max(4), componentId: PlanIdSchema }).strict())
      .min(1)
      .max(32),
    features: z
      .array(
        z.enum([
          "heading_order",
          "landmarks",
          "labels",
          "descriptions",
          "table_relationships",
          "live_status",
          "keyboard",
          "visible_focus",
          "accessible_media",
          "modal_escape",
        ]),
      )
      .min(1)
      .max(10),
    notes: z.array(PlanShortTextSchema).max(8),
  })
  .strict();

/**
 * The complete set of behaviours a generated component may implement. Each
 * is React state over data the plan already carries; nothing here can
 * reach the network, the host, or the website the data came from.
 */
export const UiPlanLocalInteractionSchema = z
  .object({
    interactionId: PlanIdSchema,
    stateKey: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z][A-Za-z0-9]*$/, "must be a lowerCamelCase state key"),
    kind: z.enum(["selection", "filter", "sort", "expansion", "tab", "gallery", "modal"]),
    label: PlanLabelSchema,
    targetComponentId: PlanIdSchema,
    /** Closed option set; bounded so the generated state can never be unbounded. */
    optionValues: z.array(planText(120, 1)).max(64),
    defaultValue: planText(120).nullable(),
  })
  .strict();

export type UiPlanLocalInteraction = z.infer<typeof UiPlanLocalInteractionSchema>;

const PlanStateCopySchema = z
  .object({ headline: PlanLabelSchema, body: PlanShortTextSchema })
  .strict();

export const UiPlanStatesSchema = z
  .object({
    empty: PlanStateCopySchema,
    loading: PlanStateCopySchema,
    error: PlanStateCopySchema,
    partial: PlanStateCopySchema,
  })
  .strict();

export const UiPlanCoverageSchema = z
  .object({
    requestedSources: z.number().int().nonnegative().max(MAX_PLAN_SOURCES),
    capturedSources: z.number().int().nonnegative().max(MAX_PLAN_SOURCES),
    /** What the plan knowingly leaves out, so the view can say so rather than implying completeness. */
    omissions: z.array(PlanShortTextSchema).max(12),
    /** Parts of the request the captures could not support at all. */
    unsupportedRequests: z.array(PlanShortTextSchema).max(12),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

/**
 * Generation constraints. The three literals are the plan restating, in the
 * payload the UI model actually reads, the prohibitions its system
 * instruction also carries -- so a plan can never be the thing that appears
 * to authorize one.
 */
export const UiPlanConstraintsSchema = z
  .object({
    maxRecordsRendered: z.number().int().min(1).max(MAX_PLAN_RECORDS),
    maxComponentsRendered: z.number().int().min(1).max(MAX_PLAN_COMPONENTS),
    requireSourceAttribution: z.literal(true),
    allowExternalActions: z.literal(false),
    allowNetworkAccess: z.literal(false),
  })
  .strict();

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const UiPlanBaseSchema = z
  .object({
    schemaVersion: z.literal(UI_PLAN_SCHEMA_VERSION),
    canonicalGoal: planText(1_000, 1),
    sources: z.array(UiPlanSourceSchema).min(1).max(MAX_PLAN_SOURCES),
    facts: z.array(UiPlanFactSchema).max(MAX_PLAN_FACTS),
    collections: z.array(UiPlanCollectionSchema).max(MAX_PLAN_COLLECTIONS),
    records: z.array(UiPlanRecordSchema).max(MAX_PLAN_RECORDS),
    media: z.array(UiPlanMediaSchema).max(MAX_PLAN_MEDIA),
    components: z.array(UiPlanComponentSchema).min(1).max(MAX_PLAN_COMPONENTS),
    informationArchitecture: UiPlanInformationArchitectureSchema,
    layout: UiPlanLayoutSchema,
    visualDirection: UiPlanVisualDirectionSchema,
    typography: UiPlanTypographySchema,
    spacing: UiPlanSpacingSchema,
    responsive: UiPlanResponsiveSchema,
    accessibility: UiPlanAccessibilitySchema,
    localInteractions: z.array(UiPlanLocalInteractionSchema).max(MAX_PLAN_INTERACTIONS),
    states: UiPlanStatesSchema,
    coverage: UiPlanCoverageSchema,
    constraints: UiPlanConstraintsSchema,
  })
  .strict();

function requireUnique(values: readonly string[], path: string, ctx: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", path: [path], message: `${path} ids must be unique` });
  }
}

function requireKnown(
  ids: readonly string[],
  known: ReadonlySet<string>,
  path: string,
  what: string,
  ctx: z.RefinementCtx,
): void {
  for (const id of ids) {
    if (!known.has(id)) {
      ctx.addIssue({ code: "custom", path: [path], message: `${path} references an unknown ${what}: ${id}` });
      return;
    }
  }
}

export const UiPlanSchema = UiPlanBaseSchema.superRefine((plan, ctx) => {
  const sourceIds = new Set(plan.sources.map((source) => source.sourceId));
  const factIds = new Set(plan.facts.map((fact) => fact.factId));
  const collectionIds = new Set(plan.collections.map((collection) => collection.collectionId));
  const recordIds = new Set(plan.records.map((record) => record.recordId));
  const mediaIds = new Set(plan.media.map((media) => media.mediaId));
  const componentIds = new Set(plan.components.map((component) => component.componentId));

  requireUnique(plan.sources.map((item) => item.sourceId), "sources", ctx);
  requireUnique(plan.facts.map((item) => item.factId), "facts", ctx);
  requireUnique(plan.collections.map((item) => item.collectionId), "collections", ctx);
  requireUnique(plan.records.map((item) => item.recordId), "records", ctx);
  requireUnique(plan.media.map((item) => item.mediaId), "media", ctx);
  requireUnique(plan.components.map((item) => item.componentId), "components", ctx);
  requireUnique(plan.localInteractions.map((item) => item.interactionId), "localInteractions", ctx);
  requireUnique(plan.localInteractions.map((item) => item.stateKey), "localInteractions", ctx);

  // Provenance: every fact, record, and media item names a captured source.
  requireKnown(plan.facts.map((fact) => fact.sourceId), sourceIds, "facts", "source", ctx);
  requireKnown(plan.records.map((record) => record.sourceId), sourceIds, "records", "source", ctx);
  requireKnown(plan.media.map((media) => media.sourceId), sourceIds, "media", "source", ctx);

  for (const record of plan.records) {
    requireUnique(record.fields.map((field) => field.fieldId), "records", ctx);
    requireKnown([record.collectionId], collectionIds, "records", "collection", ctx);
    requireKnown(record.mediaIds, mediaIds, "records", "media item", ctx);
    requireKnown(record.factIds, factIds, "records", "fact", ctx);
  }

  for (const component of plan.components) {
    requireKnown(component.childIds, componentIds, "components", "component", ctx);
    requireKnown(component.recordIds, recordIds, "components", "record", ctx);
    requireKnown(component.factIds, factIds, "components", "fact", ctx);
    requireKnown(component.mediaIds, mediaIds, "components", "media item", ctx);
    if (component.collectionId !== null && !collectionIds.has(component.collectionId)) {
      ctx.addIssue({ code: "custom", path: ["components"], message: `components references an unknown collection: ${component.collectionId}` });
    }
  }

  requireKnown(plan.informationArchitecture.sectionIds, componentIds, "informationArchitecture", "component", ctx);
  requireKnown(plan.accessibility.headingOutline.map((entry) => entry.componentId), componentIds, "accessibility", "component", ctx);
  requireKnown(plan.localInteractions.map((item) => item.targetComponentId), componentIds, "localInteractions", "component", ctx);

  // The component graph must be a rooted tree: exactly one root, every other
  // component reachable from it exactly once. A cycle here would become an
  // unbounded render in the generated component.
  const childCounts = new Map<string, number>();
  for (const component of plan.components) {
    for (const childId of component.childIds) childCounts.set(childId, (childCounts.get(childId) ?? 0) + 1);
  }
  if ([...childCounts.values()].some((count) => count > 1)) {
    ctx.addIssue({ code: "custom", path: ["components"], message: "a component may appear as a child at most once" });
  }
  const roots = plan.components.filter((component) => !childCounts.has(component.componentId));
  if (roots.length !== 1 || roots[0]!.role !== "root") {
    ctx.addIssue({ code: "custom", path: ["components"], message: "components must form a single tree rooted at the 'root' component" });
    return;
  }
  const byId = new Map(plan.components.map((component) => [component.componentId, component]));
  const seen = new Set<string>();
  const stack = [roots[0]!.componentId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) {
      ctx.addIssue({ code: "custom", path: ["components"], message: "the component tree contains a cycle" });
      return;
    }
    seen.add(id);
    for (const childId of byId.get(id)?.childIds ?? []) stack.push(childId);
  }
  if (seen.size !== plan.components.length) {
    ctx.addIssue({ code: "custom", path: ["components"], message: "every component must be reachable from the root" });
  }

  if (plan.coverage.capturedSources !== plan.sources.length) {
    ctx.addIssue({ code: "custom", path: ["coverage"], message: "capturedSources must equal the number of plan sources" });
  }
  if (plan.coverage.capturedSources > plan.coverage.requestedSources) {
    ctx.addIssue({ code: "custom", path: ["coverage"], message: "capturedSources cannot exceed requestedSources" });
  }
  if (plan.records.length > plan.constraints.maxRecordsRendered) {
    ctx.addIssue({ code: "custom", path: ["constraints"], message: "maxRecordsRendered is below the number of records supplied" });
  }
  if (plan.components.length > plan.constraints.maxComponentsRendered) {
    ctx.addIssue({ code: "custom", path: ["constraints"], message: "maxComponentsRendered is below the number of components supplied" });
  }
});

export type UiPlan = z.infer<typeof UiPlanSchema>;

/**
 * What the planning model is actually asked for: a plan with no `sources`
 * array.
 *
 * Provenance is not the planner's to author. It names sources by the
 * `sourceId`s trusted code minted for the captures, and trusted code then
 * fills in the URL, origin, title, retrieval time, and capture status from
 * its own capture records (`assembleUiPlan`). A planner therefore cannot
 * misattribute a fact to a page that was never captured, or claim a
 * capture completed when it was truncated.
 */
export const UiPlanDraftSchema = UiPlanBaseSchema.omit({ sources: true });

export type UiPlanDraft = z.infer<typeof UiPlanDraftSchema>;

/**
 * Joins a validated draft to the server's own capture records and returns a
 * fully validated `UiPlan`. Throws if the draft references a source the
 * captures do not contain -- `UiPlanSchema` checks every id resolves.
 */
export function assembleUiPlan(
  draft: UiPlanDraft,
  sources: readonly UiPlanSource[],
  requestedSources: number,
): UiPlan {
  return UiPlanSchema.parse({
    ...draft,
    sources,
    coverage: { ...draft.coverage, requestedSources, capturedSources: sources.length },
  });
}

// ---------------------------------------------------------------------------
// Canonicalization and digest
// ---------------------------------------------------------------------------

/**
 * Arrays whose order is not meaningful, and which are therefore sorted
 * before hashing so two plans that differ only in the order the planner
 * happened to emit them share one digest (and therefore one cache entry).
 * Ordered arrays -- `sectionIds`, `childIds`, `fields`, `headingOutline`,
 * `breakpoints` -- are deliberately absent: their order *is* the design.
 */
const UNORDERED_PLAN_ARRAYS: ReadonlySet<string> = new Set([
  "sources",
  "facts",
  "collections",
  "records",
  "media",
  "components",
  "localInteractions",
  "mediaIds",
  "factIds",
  "recordIds",
  "comparableFieldRoles",
  "surfaceTokens",
  "landmarks",
  "features",
  "notes",
  "omissions",
  "unsupportedRequests",
  "monospaceFor",
  "collapse",
  "optionValues",
]);

function canonicalize(value: unknown, key?: string): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    return UNORDERED_PLAN_ARRAYS.has(key ?? "")
      ? [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([entryKey, entryValue]) => [entryKey, canonicalize(entryValue, entryKey)]),
    );
  }
  return value;
}

/** Deterministic serialization of a validated plan -- the input to its digest and to the artifact cache key. */
export function canonicalizeUiPlan(plan: UiPlan): string {
  return JSON.stringify(canonicalize(UiPlanSchema.parse(plan)));
}

export function digestUiPlan(plan: UiPlan): string {
  return createHash("sha256").update(canonicalizeUiPlan(plan), "utf8").digest("hex");
}
