import { createHash } from "node:crypto";
import { z } from "zod";
import { CorrelationMetadataSchema } from "./correlation";
import { IsoDateTimeSchema } from "./primitives";
import { UiPlanSchema, canonicalizeUiPlan, digestUiPlan, type UiPlan } from "./ui-plan";

/**
 * Phase 4 generation and artifact contracts (P04-F01).
 *
 * The UI model's entire variable input is one canonical `UiPlan`. There is
 * no field here for rendered HTML, conversation history, browser state, a
 * page graph, or a website capability -- those either never existed in this
 * pipeline or stopped at the Phase 3 capture stage. What crosses this
 * boundary is the plan, the digests that pin it, the runtime the generated
 * component may import from, and the theme/limit envelope it must fit.
 *
 * The reverse direction is equally closed: TSX plus a manifest whose every
 * reference must already exist in the plan, and which is checked against
 * the plan before a single byte is compiled.
 */

export const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const DigestSchema = z.string().regex(SHA256_DIGEST_PATTERN, "must be a lowercase SHA-256 digest");

export const MAX_UI_GENERATION_SOURCE_BYTES = 64 * 1024;
export const MAX_UI_GENERATION_MANIFEST_REFERENCES = 256;
export const MAX_UI_GENERATION_LOCAL_INTERACTIONS = 32;
export const MAX_UI_GENERATION_IMPORTS = 64;

const VersionSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9._:+-]+$/);
const DisplayTextSchema = z.string().max(4_000);
const SemanticTokenSchema = z.string().min(1).max(100).regex(/^[a-z][a-z0-9.-]*$/);
const IdentifierSchema = z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9]*$/);
const PlanReferenceSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/);

export const UiGenerationLimitsSchema = z
  .object({
    maxSourceBytes: z.number().int().positive().max(MAX_UI_GENERATION_SOURCE_BYTES),
    maxAstNodes: z.number().int().positive().max(20_000),
    maxComplexity: z.number().int().positive().max(200),
    maxRenderNodes: z.number().int().positive().max(5_000),
    maxLocalStateEntries: z.number().int().nonnegative().max(MAX_UI_GENERATION_LOCAL_INTERACTIONS),
  })
  .strict();

export type UiGenerationLimits = z.infer<typeof UiGenerationLimitsSchema>;

export const UiGenerationThemeConstraintsSchema = z
  .object({
    allowedTokens: z.array(SemanticTokenSchema).min(1).max(256),
    minimumTargetSize: z.number().int().min(24).max(64),
    supportedThemes: z.array(z.enum(["light", "dark"])).min(1).max(2),
    supportsReducedMotion: z.literal(true),
    minimumViewport: z.object({ width: z.number().int().min(320), height: z.number().int().min(240) }).strict(),
    maximumZoomPercent: z.number().int().min(100).max(400),
  })
  .strict();

/**
 * The runtime the generated component may import from -- and the only
 * module specifier it may name at all. Model output cannot change this:
 * the compiler rejects any other import outright, and the exports list is
 * the server's, not the model's.
 */
export const UiRuntimeCapabilityReferenceSchema = z
  .object({
    module: z.literal("@ai-browser/generated-ui-runtime"),
    apiVersion: VersionSchema,
    exports: z.array(IdentifierSchema).min(1).max(MAX_UI_GENERATION_IMPORTS),
  })
  .strict();

export type UiRuntimeCapabilityReference = z.infer<typeof UiRuntimeCapabilityReferenceSchema>;

const UiGenerationRequestBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    promptVersion: VersionSchema,
    promptDigest: DigestSchema,
    plan: UiPlanSchema,
    planDigest: DigestSchema,
    runtime: UiRuntimeCapabilityReferenceSchema,
    theme: UiGenerationThemeConstraintsSchema,
    limits: UiGenerationLimitsSchema,
    correlation: CorrelationMetadataSchema,
  })
  .strict();

export const UiGenerationRequestSchema = UiGenerationRequestBaseSchema.superRefine((request, ctx) => {
  if (digestUiPlan(request.plan) !== request.planDigest) {
    ctx.addIssue({ code: "custom", path: ["planDigest"], message: "planDigest does not match the canonical plan" });
  }
  const allowed = new Set(request.theme.allowedTokens);
  for (const token of [request.plan.visualDirection.accentToken, ...request.plan.visualDirection.surfaceTokens]) {
    if (!allowed.has(token)) {
      ctx.addIssue({ code: "custom", path: ["plan"], message: `visual direction names a token outside the theme: ${token}` });
      return;
    }
  }
  if (request.plan.localInteractions.length > request.limits.maxLocalStateEntries) {
    ctx.addIssue({ code: "custom", path: ["limits"], message: "the plan declares more local interactions than the limits allow" });
  }
});

export type UiGenerationRequest = z.infer<typeof UiGenerationRequestSchema>;

export const UiLocalInteractionSchema = z
  .object({
    stateKey: z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    kind: z.enum(["selection", "filter", "sort", "expansion", "tab", "gallery", "modal"]),
    boundedValues: z.number().int().positive().max(10_000),
  })
  .strict();

/**
 * What the generated source claims to reference and do. Every id here is a
 * plan id, and `validateUiGenerationResponseForRequest` rejects any that
 * the plan does not declare -- so a fabricated record, fact, or media id
 * fails before compilation rather than rendering as an invented row.
 */
export const GeneratedUiArtifactManifestSchema = z
  .object({
    planDigest: DigestSchema,
    sourceIds: z.array(PlanReferenceSchema).max(MAX_UI_GENERATION_MANIFEST_REFERENCES),
    recordIds: z.array(PlanReferenceSchema).max(MAX_UI_GENERATION_MANIFEST_REFERENCES),
    factIds: z.array(PlanReferenceSchema).max(MAX_UI_GENERATION_MANIFEST_REFERENCES),
    mediaIds: z.array(PlanReferenceSchema).max(MAX_UI_GENERATION_MANIFEST_REFERENCES),
    componentIds: z.array(PlanReferenceSchema).max(MAX_UI_GENERATION_MANIFEST_REFERENCES),
    localInteractions: z.array(UiLocalInteractionSchema).max(MAX_UI_GENERATION_LOCAL_INTERACTIONS),
    accessibilityFeatures: z
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
      .max(16),
    responsiveRegions: z.array(z.string().min(1).max(100)).max(64),
    runtimeImports: z.array(IdentifierSchema).max(MAX_UI_GENERATION_IMPORTS),
    fallback: z.boolean(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    for (const key of [
      "sourceIds",
      "recordIds",
      "factIds",
      "mediaIds",
      "componentIds",
      "responsiveRegions",
      "runtimeImports",
    ] as const) {
      if (new Set(manifest[key]).size !== manifest[key].length) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} must be unique` });
      }
    }
    const stateKeys = manifest.localInteractions.map((item) => item.stateKey);
    if (new Set(stateKeys).size !== stateKeys.length) {
      ctx.addIssue({ code: "custom", path: ["localInteractions"], message: "localInteractions must be unique" });
    }
  });

export type GeneratedUiArtifactManifest = z.infer<typeof GeneratedUiArtifactManifestSchema>;

export const UiGenerationFallbackReasonSchema = z.enum([
  "insufficient_evidence",
  "unsafe_input",
  "unsupported_runtime",
  "source_limit",
  "model_refusal",
  "generation_failed",
  "validation_failed",
  "compilation_failed",
  "expired",
]);

export const UiGenerationResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    tsxSource: z
      .string()
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_UI_GENERATION_SOURCE_BYTES, "TSX source exceeds byte limit")
      .nullable(),
    manifest: GeneratedUiArtifactManifestSchema,
    modelIdentifier: z.string().min(1).max(200),
    promptDigest: DigestSchema,
    inputDigest: DigestSchema,
    runtimeVersion: VersionSchema,
    toolchainVersion: VersionSchema,
    fallbackReason: UiGenerationFallbackReasonSchema.nullable(),
  })
  .strict()
  .superRefine((response, ctx) => {
    if (
      (response.tsxSource === null) !== (response.fallbackReason !== null) ||
      response.manifest.fallback !== (response.fallbackReason !== null)
    ) {
      ctx.addIssue({ code: "custom", path: ["fallbackReason"], message: "fallback response must omit source and mark its manifest" });
    }
  });

export type UiGenerationResponse = z.infer<typeof UiGenerationResponseSchema>;

export const GeneratedUiValidationIssueSchema = z
  .object({
    code: z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]*$/),
    severity: z.enum(["error", "warning"]),
    location: z.object({ line: z.number().int().positive(), column: z.number().int().nonnegative() }).strict().nullable(),
  })
  .strict();

/**
 * An immutable, content-addressed compiled artifact. Raw model output is
 * never served: only these validated bytes are, and only until `expiresAt`.
 */
export const CompiledGeneratedUiArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z.string().regex(/^gui_[a-f0-9]{64}$/),
    module: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("bytes"), encoding: z.literal("base64"), value: z.string().max(512_000) }).strict(),
      z
        .object({ kind: z.literal("bundle_reference"), reference: z.string().min(1).max(128), byteLength: z.number().int().nonnegative().max(384_000) })
        .strict(),
    ]),
    manifest: GeneratedUiArtifactManifestSchema,
    validation: z.object({ valid: z.boolean(), issues: z.array(GeneratedUiValidationIssueSchema).max(256) }).strict(),
    sourceMapPolicy: z.literal("omitted"),
    planDigest: DigestSchema,
    inputDigest: DigestSchema,
    promptDigest: DigestSchema,
    modelDigest: DigestSchema,
    toolchainDigest: DigestSchema,
    expiresAt: IsoDateTimeSchema,
    fallbackText: DisplayTextSchema.nullable(),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    if (artifact.validation.valid === artifact.validation.issues.some((issue) => issue.severity === "error")) {
      ctx.addIssue({ code: "custom", path: ["validation"], message: "valid must agree with error issues" });
    }
  });

export type CompiledGeneratedUiArtifact = z.infer<typeof CompiledGeneratedUiArtifactSchema>;

/**
 * Canonical cache input. `correlation` is dropped wholesale -- it is the
 * per-request/session/owner noise the cache key must not depend on -- and
 * the plan is canonicalized by its own rules, so two requests that differ
 * only in emission order hash identically.
 */
export function canonicalizeUiGenerationRequest(request: UiGenerationRequest): string {
  const parsed = UiGenerationRequestSchema.parse(request);
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    promptVersion: parsed.promptVersion,
    promptDigest: parsed.promptDigest,
    plan: JSON.parse(canonicalizeUiPlan(parsed.plan)) as unknown,
    planDigest: parsed.planDigest,
    runtime: { ...parsed.runtime, exports: [...parsed.runtime.exports].sort() },
    theme: {
      ...parsed.theme,
      allowedTokens: [...parsed.theme.allowedTokens].sort(),
      supportedThemes: [...parsed.theme.supportedThemes].sort(),
    },
    limits: parsed.limits,
  });
}

export function digestUiGenerationRequest(request: UiGenerationRequest): string {
  return createHash("sha256").update(canonicalizeUiGenerationRequest(request), "utf8").digest("hex");
}

/** Every manifest reference the plan actually supports, keyed by manifest field. */
function allowedReferences(plan: UiPlan): Readonly<Record<"sourceIds" | "recordIds" | "factIds" | "mediaIds" | "componentIds", ReadonlySet<string>>> {
  return {
    sourceIds: new Set(plan.sources.map((item) => item.sourceId)),
    recordIds: new Set(plan.records.map((item) => item.recordId)),
    factIds: new Set(plan.facts.map((item) => item.factId)),
    mediaIds: new Set(plan.media.map((item) => item.mediaId)),
    componentIds: new Set(plan.components.map((item) => item.componentId)),
  };
}

/**
 * The response gate. A manifest that names an id the plan does not
 * declare, a state key the plan did not plan for, a runtime import the
 * server did not offer, or a digest that does not pin this exact request is
 * rejected here -- before compilation, registration, or rendering.
 */
export function validateUiGenerationResponseForRequest(request: UiGenerationRequest, value: unknown): UiGenerationResponse {
  const response = UiGenerationResponseSchema.parse(value);
  const allowed = allowedReferences(request.plan);
  for (const key of Object.keys(allowed) as Array<keyof typeof allowed>) {
    for (const id of response.manifest[key]) {
      if (!allowed[key].has(id)) throw new Error(`manifest contains forged ${key}: ${id}`);
    }
  }
  const plannedStateKeys = new Set(request.plan.localInteractions.map((item) => item.stateKey));
  for (const interaction of response.manifest.localInteractions) {
    if (!plannedStateKeys.has(interaction.stateKey)) {
      throw new Error(`manifest declares an unplanned local interaction: ${interaction.stateKey}`);
    }
  }
  const runtimeExports = new Set(request.runtime.exports);
  for (const name of response.manifest.runtimeImports) {
    if (!runtimeExports.has(name)) throw new Error(`manifest imports an unavailable runtime export: ${name}`);
  }
  if (response.manifest.planDigest !== request.planDigest) throw new Error("manifest plan digest does not match request");
  if (response.promptDigest !== request.promptDigest) throw new Error("response prompt digest does not match request");
  if (response.inputDigest !== digestUiGenerationRequest(request)) throw new Error("response input digest does not match canonical request");
  return response;
}
