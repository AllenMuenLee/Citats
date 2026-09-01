import { createHash } from "node:crypto";
import { z } from "zod";
import { CorrelationMetadataSchema } from "./correlation";
import { IsoDateTimeSchema } from "./primitives";
import {
  CoverageReportSchema,
  InteractionCapabilitySchema,
  InteractionExecutionSchema,
  OpaqueHandleSchema,
  PageNodeSchema,
  PageRegionSchema,
  PageRelationshipSchema,
  PageWarningSchema,
  RepeatedCollectionSchema,
  UiSourceCandidateSchema,
  UiSourceFieldRoleSchema,
  WebsiteUiFreshnessSchema,
  WebsiteUiMetadataSchema,
  digestWebsiteUiMetadata,
} from "./page-understanding";

export const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const DigestSchema = z.string().regex(SHA256_DIGEST_PATTERN, "must be a lowercase SHA-256 digest");

export const UI_IMPLEMENTATION_PROMPT_MAX_LENGTH = 24_000;

/**
 * The Phase 3 extraction model's UI implementation prompt: free-form prose
 * covering website style, static content, internal React interactions,
 * external AI-action intents, and the metadata artifact.
 *
 * Deliberately unstructured. Nothing validates its headings, ordering, or
 * wording, because a useful plan phrased differently is still a useful
 * plan -- the checkable facts live in `metadata` instead. It is untrusted,
 * model-authored text, subordinate to the server-owned system instruction
 * wherever the two disagree.
 */
export const UiImplementationPromptSchema = z.string().trim().min(1).max(UI_IMPLEMENTATION_PROMPT_MAX_LENGTH);

export const MAX_BRIEF_COLLECTION_HANDLES = 10;
export const MAX_BRIEF_DETAIL_REGIONS = 5;
export const MAX_BRIEF_IMPORTANT_FIELDS = 24;
export const MAX_BRIEF_COMPARISON_REQUIREMENTS = 12;
export const MAX_BRIEF_WARNINGS = 16;

/**
 * `UiGenerationBrief` (P03-F05 step 6): the validated envelope around the
 * free-form implementation prompt and its `WebsiteUiMetadata` companion.
 *
 * Everything outside `implementationPrompt` is checkable and is checked --
 * handles must belong to the same observation, and `metadataDigest` must
 * match the canonical serialization of `metadata`, so a plan can never be
 * paired with metadata it was not written against.
 */
export const UiGenerationBriefSchema = z
  .object({
    schemaVersion: z.literal(1),
    observationId: OpaqueHandleSchema,
    canonicalUserGoal: z.string().trim().min(1).max(2_000),
    implementationPrompt: UiImplementationPromptSchema,
    metadata: WebsiteUiMetadataSchema,
    metadataDigest: DigestSchema,
    prioritizedCollectionHandles: z.array(OpaqueHandleSchema).max(MAX_BRIEF_COLLECTION_HANDLES),
    detailRegionHandles: z.array(OpaqueHandleSchema).max(MAX_BRIEF_DETAIL_REGIONS),
    importantFields: z.array(UiSourceFieldRoleSchema).max(MAX_BRIEF_IMPORTANT_FIELDS),
    comparisonRequirements: z.array(z.string().min(1).max(300)).max(MAX_BRIEF_COMPARISON_REQUIREMENTS),
    freshness: WebsiteUiFreshnessSchema,
    warnings: z.array(z.string().max(300)).max(MAX_BRIEF_WARNINGS),
  })
  .strict()
  .superRefine((brief, ctx) => {
    if (brief.metadata.observationId !== brief.observationId) {
      ctx.addIssue({ code: "custom", path: ["metadata"], message: "metadata belongs to a different observation" });
    }
    if (digestWebsiteUiMetadata(brief.metadata) !== brief.metadataDigest) {
      ctx.addIssue({ code: "custom", path: ["metadataDigest"], message: "metadata digest does not match the canonical metadata" });
    }
  });

export type UiGenerationBrief = z.infer<typeof UiGenerationBriefSchema>;

export const MAX_UI_GENERATION_SOURCE_BYTES = 64 * 1024;
export const MAX_UI_GENERATION_BINDINGS = 256;
export const MAX_UI_GENERATION_MANIFEST_REFERENCES = 256;
export const MAX_UI_GENERATION_LOCAL_INTERACTIONS = 32;
export const MAX_UI_GENERATION_IMPORTS = 64;
export const MAX_UI_GENERATION_WARNINGS = 32;

const VersionSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9._:+-]+$/);
const DisplayTextSchema = z.string().max(4_000);
const SemanticTokenSchema = z.string().min(1).max(100).regex(/^[a-z][a-z0-9.-]*$/);

export const UiSourceBindingSchema = z.object({
  sourceId: OpaqueHandleSchema,
  candidate: UiSourceCandidateSchema,
  provider: z.string().min(1).max(200),
  displayLabel: z.string().min(1).max(300),
}).strict();

export const UiRecordBindingSchema = z.object({
  recordId: OpaqueHandleSchema,
  collectionId: OpaqueHandleSchema,
  fieldNodeIds: z.array(OpaqueHandleSchema).max(32),
}).strict();

export const UiMediaBindingSchema = z.object({
  mediaId: OpaqueHandleSchema,
  nodeId: OpaqueHandleSchema,
  kind: z.enum(["image", "audio", "video", "chart"]),
  altText: z.string().min(1).max(1_000),
  safeReference: OpaqueHandleSchema,
}).strict();

export const UiCapabilityBindingSchema = z.object({
  capabilityId: OpaqueHandleSchema,
  capability: InteractionCapabilitySchema,
  allowedCommandKinds: z.array(z.enum(["activate", "select", "set_value", "open_detail", "media_control"])).max(8),
  argumentSchemaId: OpaqueHandleSchema,
  /**
   * How the generated component may run this binding. `internal_react`
   * bindings are React-only and carry no prompt template: emitting a
   * command for one is a policy violation, not a supported path.
   */
  interactionExecution: InteractionExecutionSchema,
  promptTemplateId: OpaqueHandleSchema.nullable(),
}).strict().superRefine((binding, ctx) => {
  const external = binding.interactionExecution === "external_ai_action";
  if (external !== (binding.promptTemplateId !== null)) {
    ctx.addIssue({ code: "custom", path: ["promptTemplateId"], message: "a prompt template id is required exactly for external_ai_action bindings" });
  }
  if (binding.interactionExecution !== binding.capability.interactionExecution) {
    ctx.addIssue({ code: "custom", path: ["interactionExecution"], message: "binding disagrees with its capability's execution classification" });
  }
  if (external && binding.promptTemplateId !== binding.capability.promptTemplateId) {
    ctx.addIssue({ code: "custom", path: ["promptTemplateId"], message: "binding prompt template does not match its capability" });
  }
});

export type UiCapabilityBinding = z.infer<typeof UiCapabilityBindingSchema>;

export const UiGenerationLimitsSchema = z.object({
  maxSourceBytes: z.number().int().positive().max(MAX_UI_GENERATION_SOURCE_BYTES),
  maxAstNodes: z.number().int().positive().max(20_000),
  maxComplexity: z.number().int().positive().max(200),
  maxRenderNodes: z.number().int().positive().max(5_000),
  maxLocalStateEntries: z.number().int().nonnegative().max(MAX_UI_GENERATION_LOCAL_INTERACTIONS),
}).strict();

export const UiGenerationThemeConstraintsSchema = z.object({
  allowedTokens: z.array(SemanticTokenSchema).min(1).max(256),
  minimumTargetSize: z.number().int().min(24).max(64),
  supportedThemes: z.array(z.enum(["light", "dark"])).min(1).max(2),
  supportsReducedMotion: z.literal(true),
  minimumViewport: z.object({ width: z.number().int().min(320), height: z.number().int().min(240) }).strict(),
  maximumZoomPercent: z.number().int().min(100).max(400),
}).strict();

const UiGenerationRequestBaseSchema = z.object({
  schemaVersion: z.literal(1),
  promptVersion: VersionSchema,
  promptDigest: DigestSchema,
  canonicalUserTask: z.string().trim().min(1).max(2_000),
  brief: UiGenerationBriefSchema,
  /**
   * The Phase 3 implementation prompt and metadata artifact, lifted out of
   * `brief` so the UI adapter can address them directly. Both are copies of
   * the brief's own values and are checked against it below -- the brief
   * stays the single source of truth.
   */
  implementationPrompt: UiImplementationPromptSchema,
  websiteUiMetadata: WebsiteUiMetadataSchema,
  websiteUiMetadataDigest: DigestSchema,
  graph: z.object({
    nodes: z.array(PageNodeSchema).max(512),
    relationships: z.array(PageRelationshipSchema).max(1_024),
    regions: z.array(PageRegionSchema).max(128),
    collections: z.array(RepeatedCollectionSchema).max(64),
  }).strict(),
  sourceBindings: z.array(UiSourceBindingSchema).max(MAX_UI_GENERATION_BINDINGS),
  recordBindings: z.array(UiRecordBindingSchema).max(MAX_UI_GENERATION_BINDINGS),
  mediaBindings: z.array(UiMediaBindingSchema).max(MAX_UI_GENERATION_BINDINGS),
  capabilityBindings: z.array(UiCapabilityBindingSchema).max(MAX_UI_GENERATION_BINDINGS),
  coverage: CoverageReportSchema,
  freshness: WebsiteUiFreshnessSchema,
  warnings: z.array(PageWarningSchema).max(MAX_UI_GENERATION_WARNINGS),
  runtimeApiVersion: VersionSchema,
  theme: UiGenerationThemeConstraintsSchema,
  limits: UiGenerationLimitsSchema,
  correlation: CorrelationMetadataSchema,
}).strict();

function duplicateIssue(values: readonly string[], path: string, ctx: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: [path], message: `${path} must be unique` });
}

export const UiGenerationRequestSchema = UiGenerationRequestBaseSchema.superRefine((request, ctx) => {
  duplicateIssue(request.sourceBindings.map((item) => item.sourceId), "sourceBindings", ctx);
  duplicateIssue(request.recordBindings.map((item) => item.recordId), "recordBindings", ctx);
  duplicateIssue(request.mediaBindings.map((item) => item.mediaId), "mediaBindings", ctx);
  duplicateIssue(request.capabilityBindings.map((item) => item.capabilityId), "capabilityBindings", ctx);
  if (request.implementationPrompt !== request.brief.implementationPrompt) {
    ctx.addIssue({ code: "custom", path: ["implementationPrompt"], message: "implementation prompt does not match the validated brief" });
  }
  if (request.websiteUiMetadataDigest !== request.brief.metadataDigest) {
    ctx.addIssue({ code: "custom", path: ["websiteUiMetadataDigest"], message: "metadata digest does not match the validated brief" });
  }
  if (digestWebsiteUiMetadata(request.websiteUiMetadata) !== request.websiteUiMetadataDigest) {
    ctx.addIssue({ code: "custom", path: ["websiteUiMetadata"], message: "metadata digest does not match the canonical metadata" });
  }
  // Every external binding must be declared in the metadata artifact, so the
  // trusted server can always resolve a command's prompt template from data
  // it validated rather than from anything the generated component sent.
  const declaredExternal = new Map(request.websiteUiMetadata.externalCapabilities.map((item) => [item.capabilityId, item.promptTemplateId]));
  const declaredInternal = new Set(request.websiteUiMetadata.internalInteractions.map((item) => item.capabilityId));
  for (const binding of request.capabilityBindings) {
    if (binding.interactionExecution === "external_ai_action") {
      if (declaredExternal.get(binding.capabilityId) !== binding.promptTemplateId) {
        ctx.addIssue({ code: "custom", path: ["capabilityBindings"], message: `external capability ${binding.capabilityId} is not declared in the website metadata` });
      }
    } else if (!declaredInternal.has(binding.capabilityId)) {
      ctx.addIssue({ code: "custom", path: ["capabilityBindings"], message: `internal capability ${binding.capabilityId} is not declared in the website metadata` });
    }
  }
});
export type UiGenerationRequest = z.infer<typeof UiGenerationRequestSchema>;

export const UiLocalInteractionSchema = z.object({
  stateKey: z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  kind: z.enum(["selection", "filter", "sort", "expansion", "tab", "gallery", "modal"]),
  boundedValues: z.number().int().positive().max(10_000),
}).strict();

export const GeneratedUiArtifactManifestSchema = z.object({
  observationIds: z.array(OpaqueHandleSchema).min(1).max(MAX_UI_GENERATION_MANIFEST_REFERENCES),
  sourceIds: z.array(OpaqueHandleSchema).max(MAX_UI_GENERATION_MANIFEST_REFERENCES),
  recordIds: z.array(OpaqueHandleSchema).max(MAX_UI_GENERATION_MANIFEST_REFERENCES),
  mediaIds: z.array(OpaqueHandleSchema).max(MAX_UI_GENERATION_MANIFEST_REFERENCES),
  capabilityIds: z.array(OpaqueHandleSchema).max(MAX_UI_GENERATION_MANIFEST_REFERENCES),
  emittedCommandKinds: z.array(z.enum(["activate", "select", "set_value", "open_detail", "media_control"])).max(16),
  localInteractions: z.array(UiLocalInteractionSchema).max(MAX_UI_GENERATION_LOCAL_INTERACTIONS),
  accessibilityFeatures: z.array(z.enum(["heading_order", "landmarks", "labels", "descriptions", "table_relationships", "live_status", "keyboard", "visible_focus", "accessible_media", "modal_escape"])).max(16),
  responsiveRegions: z.array(z.string().min(1).max(100)).max(64),
  runtimeImports: z.array(z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9]*$/)).max(MAX_UI_GENERATION_IMPORTS),
  fallback: z.boolean(),
}).strict().superRefine((manifest, ctx) => {
  for (const key of ["observationIds", "sourceIds", "recordIds", "mediaIds", "capabilityIds", "emittedCommandKinds", "responsiveRegions", "runtimeImports"] as const) {
    duplicateIssue(manifest[key], key, ctx);
  }
  duplicateIssue(manifest.localInteractions.map((item) => item.stateKey), "localInteractions", ctx);
});
export type GeneratedUiArtifactManifest = z.infer<typeof GeneratedUiArtifactManifestSchema>;

export const UiGenerationFallbackReasonSchema = z.enum(["insufficient_evidence", "unsafe_input", "unsupported_runtime", "source_limit", "model_refusal", "generation_failed", "validation_failed", "compilation_failed", "expired"]);

export const UiGenerationResponseSchema = z.object({
  schemaVersion: z.literal(1),
  tsxSource: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_UI_GENERATION_SOURCE_BYTES, "TSX source exceeds byte limit").nullable(),
  manifest: GeneratedUiArtifactManifestSchema,
  modelIdentifier: z.string().min(1).max(200),
  promptDigest: DigestSchema,
  inputDigest: DigestSchema,
  runtimeVersion: VersionSchema,
  toolchainVersion: VersionSchema,
  fallbackReason: UiGenerationFallbackReasonSchema.nullable(),
}).strict().superRefine((response, ctx) => {
  if ((response.tsxSource === null) !== (response.fallbackReason !== null) || response.manifest.fallback !== (response.fallbackReason !== null)) {
    ctx.addIssue({ code: "custom", path: ["fallbackReason"], message: "fallback response must omit source and mark its manifest" });
  }
});
export type UiGenerationResponse = z.infer<typeof UiGenerationResponseSchema>;

export const GeneratedUiValidationIssueSchema = z.object({
  code: z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]*$/),
  severity: z.enum(["error", "warning"]),
  location: z.object({ line: z.number().int().positive(), column: z.number().int().nonnegative() }).strict().nullable(),
}).strict();

export const CompiledGeneratedUiArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: z.string().regex(/^gui_[a-f0-9]{64}$/),
  module: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("bytes"), encoding: z.literal("base64"), value: z.string().max(512_000) }).strict(),
    z.object({ kind: z.literal("bundle_reference"), reference: OpaqueHandleSchema, byteLength: z.number().int().nonnegative().max(384_000) }).strict(),
  ]),
  manifest: GeneratedUiArtifactManifestSchema,
  validation: z.object({ valid: z.boolean(), issues: z.array(GeneratedUiValidationIssueSchema).max(256) }).strict(),
  sourceMapPolicy: z.literal("omitted"),
  inputDigest: DigestSchema,
  promptDigest: DigestSchema,
  modelDigest: DigestSchema,
  toolchainDigest: DigestSchema,
  expiresAt: IsoDateTimeSchema,
  fallbackText: DisplayTextSchema.nullable(),
}).strict().superRefine((artifact, ctx) => {
  if (artifact.validation.valid === artifact.validation.issues.some((issue) => issue.severity === "error")) ctx.addIssue({ code: "custom", path: ["validation"], message: "valid must agree with error issues" });
});
export type CompiledGeneratedUiArtifact = z.infer<typeof CompiledGeneratedUiArtifactSchema>;

function canonicalize(value: unknown, key?: string): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    const unordered = new Set(["sourceBindings", "recordBindings", "mediaBindings", "capabilityBindings", "warnings", "allowedTokens", "supportedThemes", "fieldNodeIds", "allowedCommandKinds", "recordIds", "mediaIds", "internalInteractions", "externalCapabilities", "confirmationFields", "argumentSchema", "importantFields", "comparisonRequirements", "notes"]);
    return unordered.has(key ?? "") ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : items;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([entryKey]) => entryKey !== "correlation")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([entryKey, entryValue]) => [entryKey, canonicalize(entryValue, entryKey)]));
  }
  return value;
}

export function canonicalizeUiGenerationRequest(request: UiGenerationRequest): string {
  return JSON.stringify(canonicalize(UiGenerationRequestSchema.parse(request)));
}

export function digestUiGenerationRequest(request: UiGenerationRequest): string {
  return createHash("sha256").update(canonicalizeUiGenerationRequest(request), "utf8").digest("hex");
}

export function validateUiGenerationResponseForRequest(request: UiGenerationRequest, value: unknown): UiGenerationResponse {
  const response = UiGenerationResponseSchema.parse(value);
  const allowed = {
    observationIds: new Set([request.brief.observationId]),
    sourceIds: new Set(request.sourceBindings.map((item) => item.sourceId)),
    recordIds: new Set(request.recordBindings.map((item) => item.recordId)),
    mediaIds: new Set(request.mediaBindings.map((item) => item.mediaId)),
    capabilityIds: new Set(request.capabilityBindings.map((item) => item.capabilityId)),
  };
  for (const key of Object.keys(allowed) as Array<keyof typeof allowed>) {
    for (const id of response.manifest[key]) if (!allowed[key].has(id)) throw new Error(`manifest contains forged ${key}: ${id}`);
  }
  if (response.promptDigest !== request.promptDigest) throw new Error("response prompt digest does not match request");
  if (response.inputDigest !== digestUiGenerationRequest(request)) throw new Error("response input digest does not match canonical request");
  return response;
}
