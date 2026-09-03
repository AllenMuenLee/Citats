import { createHash } from "node:crypto";
import { z } from "zod";
import { CorrelationMetadataSchema } from "./correlation";
import { IsoDateTimeSchema } from "./primitives";

/**
 * Phase 4 generation and artifact contracts (P04-F01).
 *
 * The UI model's entire variable input is one free-form implementation
 * prompt -- plain text the UI planning stage wrote from the trusted request
 * and the captured evidence. There is no `UiPlan`, no plan schema, and no
 * plan checker on this boundary: nothing here parses, repairs, or validates
 * the implementation prompt against a hardcoded planning structure. It is
 * carried as bounded, untrusted text and hashed into artifact/cache
 * identity alongside both versioned policies.
 *
 * What else crosses this boundary is fixed server policy: the trusted
 * source metadata the finished view may attribute, the runtime the
 * generated component may import from, and the theme/limit envelope it must
 * fit.
 *
 * The reverse direction is closed: TSX plus a manifest whose declared
 * trusted sources, local interactions, accessibility features, responsive
 * regions, and runtime imports are all checked against the request and the
 * generated code before a single byte is compiled.
 */

export const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const DigestSchema = z.string().regex(SHA256_DIGEST_PATTERN, "must be a lowercase SHA-256 digest");

export const MAX_UI_GENERATION_SOURCE_BYTES = 64 * 1024;
export const MAX_UI_GENERATION_MANIFEST_REFERENCES = 256;
export const MAX_UI_GENERATION_LOCAL_INTERACTIONS = 32;
export const MAX_UI_GENERATION_IMPORTS = 64;
export const MAX_COMPILED_UI_BYTES = 384_000;
export const MAX_UI_GENERATION_TRUSTED_SOURCES = 12;
export const MAX_IMPLEMENTATION_PROMPT_CHARS = 200_000;
export const MAX_TRUSTED_REQUEST_LENGTH = 2_000;

const VersionSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9._:+-]+$/);
const DisplayTextSchema = z.string().max(4_000);
const SemanticTokenSchema = z.string().min(1).max(100).regex(/^[a-z][a-z0-9.-]*$/);
const IdentifierSchema = z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9]*$/);
const ReferenceIdSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/);

/**
 * The planner's free-form implementation prompt: plain text, passed through
 * untouched. Nothing parses, repairs, validates, or matches it against any
 * structure. The only bound is a loose upper size limit so a pathological
 * response cannot exhaust downstream memory -- it is a DoS guard, not
 * content validation.
 */
export const ImplementationPromptSchema = z.string().min(1).max(MAX_IMPLEMENTATION_PROMPT_CHARS);

/** The trusted user request, carried for the display label and the pane title. */
export const TrustedRequestSchema = z.string().trim().min(1).max(MAX_TRUSTED_REQUEST_LENGTH);

/**
 * One captured website, as trusted code recorded it. The generated view may
 * attribute content to these and nothing else; the URL is identity and
 * provenance, never something the sandbox can fetch or link to.
 */
export const TrustedGenerationSourceSchema = z
  .object({
    sourceId: ReferenceIdSchema,
    finalUrl: z
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
      }),
    origin: z.string().min(1).max(253),
    title: z.string().min(1).max(200),
    retrievedAt: IsoDateTimeSchema,
    captureStatus: z.enum(["complete", "truncated", "partial"]),
  })
  .strict();

export type TrustedGenerationSource = z.infer<typeof TrustedGenerationSourceSchema>;

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

/** sha256 of the planner's implementation prompt, the value pinned by `implementationPromptDigest`. */
export function digestImplementationPrompt(implementationPrompt: string): string {
  return createHash("sha256").update(implementationPrompt, "utf8").digest("hex");
}

const UiGenerationRequestBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Versioned server-owned planner policy. */
    plannerPromptVersion: VersionSchema,
    plannerPromptDigest: DigestSchema,
    /** Versioned server-owned UI_MODEL policy. */
    promptVersion: VersionSchema,
    promptDigest: DigestSchema,
    trustedRequest: TrustedRequestSchema,
    implementationPrompt: ImplementationPromptSchema,
    implementationPromptDigest: DigestSchema,
    trustedSources: z.array(TrustedGenerationSourceSchema).min(1).max(MAX_UI_GENERATION_TRUSTED_SOURCES),
    runtime: UiRuntimeCapabilityReferenceSchema,
    theme: UiGenerationThemeConstraintsSchema,
    limits: UiGenerationLimitsSchema,
    correlation: CorrelationMetadataSchema,
  })
  .strict();

export const UiGenerationRequestSchema = UiGenerationRequestBaseSchema.superRefine((request, ctx) => {
  if (digestImplementationPrompt(request.implementationPrompt) !== request.implementationPromptDigest) {
    ctx.addIssue({ code: "custom", path: ["implementationPromptDigest"], message: "implementationPromptDigest does not match the implementation prompt" });
  }
  const sourceIds = request.trustedSources.map((source) => source.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    ctx.addIssue({ code: "custom", path: ["trustedSources"], message: "trusted source ids must be unique" });
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
 * What the generated source claims to reference and do. `sourceIds` are
 * checked against the request's trusted sources, and the static validator
 * checks every other declaration against the generated code itself -- so a
 * fabricated attribution or an undeclared interaction fails before
 * compilation. There is no planner-authored record, fact, media, or
 * component id here: the planner emits free-form text, not ids.
 */
export const GeneratedUiArtifactManifestSchema = z
  .object({
    sourceIds: z.array(ReferenceIdSchema).max(MAX_UI_GENERATION_MANIFEST_REFERENCES),
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
    for (const key of ["sourceIds", "responsiveRegions", "runtimeImports"] as const) {
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
 * The `artifactId` binds the bytes to the implementation prompt, both
 * versioned policies (through `inputDigest`), the model, and the toolchain.
 */
export const CompiledGeneratedUiArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z.string().regex(/^gui_[a-f0-9]{64}$/),
    module: z
      .object({
        kind: z.literal("bytes"),
        encoding: z.literal("base64"),
        value: z
          .string()
          .min(4)
          .max(512_000)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "must be canonical base64"),
      })
      .strict(),
    manifest: GeneratedUiArtifactManifestSchema,
    validation: z.object({ valid: z.boolean(), issues: z.array(GeneratedUiValidationIssueSchema).max(256) }).strict(),
    sourceMapPolicy: z.literal("omitted"),
    implementationPromptDigest: DigestSchema,
    inputDigest: DigestSchema,
    promptDigest: DigestSchema,
    modelDigest: DigestSchema,
    toolchainDigest: DigestSchema,
    expiresAt: IsoDateTimeSchema,
    fallbackText: DisplayTextSchema.nullable(),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    const bytes = Buffer.from(artifact.module.value, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_COMPILED_UI_BYTES) {
      ctx.addIssue({ code: "custom", path: ["module", "value"], message: "compiled module byte size is invalid" });
    }
    if (!artifact.validation.valid || artifact.validation.issues.some((issue) => issue.severity === "error")) {
      ctx.addIssue({ code: "custom", path: ["validation"], message: "valid must agree with error issues" });
    }
    if (
      artifact.artifactId !==
      computeGeneratedUiArtifactId({
        bytes,
        implementationPromptDigest: artifact.implementationPromptDigest,
        inputDigest: artifact.inputDigest,
        promptDigest: artifact.promptDigest,
        modelDigest: artifact.modelDigest,
        toolchainDigest: artifact.toolchainDigest,
      })
    ) {
      ctx.addIssue({ code: "custom", path: ["artifactId"], message: "artifactId does not match compiled bytes and identity digests" });
    }
    if (artifact.manifest.fallback || artifact.fallbackText === null) {
      ctx.addIssue({ code: "custom", path: ["fallbackText"], message: "compiled artifacts require a trusted fallback and a non-fallback manifest" });
    }
  });

export type CompiledGeneratedUiArtifact = z.infer<typeof CompiledGeneratedUiArtifactSchema>;

export function computeGeneratedUiArtifactId(input: {
  bytes: Uint8Array;
  implementationPromptDigest: string;
  inputDigest: string;
  promptDigest: string;
  modelDigest: string;
  toolchainDigest: string;
}): string {
  const implementationPromptDigest = DigestSchema.parse(input.implementationPromptDigest);
  const inputDigest = DigestSchema.parse(input.inputDigest);
  const promptDigest = DigestSchema.parse(input.promptDigest);
  const modelDigest = DigestSchema.parse(input.modelDigest);
  const toolchainDigest = DigestSchema.parse(input.toolchainDigest);
  const digest = createHash("sha256")
    .update(input.bytes)
    .update(implementationPromptDigest)
    .update(inputDigest)
    .update(promptDigest)
    .update(modelDigest)
    .update(toolchainDigest)
    .digest("hex");
  return `gui_${digest}`;
}

/**
 * Canonical cache input. `correlation` is dropped wholesale -- it is the
 * per-request/session/owner noise the cache key must not depend on -- and
 * the trusted sources are sorted by id, so two requests that differ only in
 * emission order hash identically. Both versioned policy digests and the
 * implementation-prompt digest are part of the hash.
 */
export function canonicalizeUiGenerationRequest(request: UiGenerationRequest): string {
  const parsed = UiGenerationRequestSchema.parse(request);
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    plannerPromptVersion: parsed.plannerPromptVersion,
    plannerPromptDigest: parsed.plannerPromptDigest,
    promptVersion: parsed.promptVersion,
    promptDigest: parsed.promptDigest,
    trustedRequest: parsed.trustedRequest,
    implementationPrompt: parsed.implementationPrompt,
    implementationPromptDigest: parsed.implementationPromptDigest,
    trustedSources: [...parsed.trustedSources]
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
      .map((source) => ({
        sourceId: source.sourceId,
        finalUrl: source.finalUrl,
        origin: source.origin,
        title: source.title,
        retrievedAt: source.retrievedAt,
        captureStatus: source.captureStatus,
      })),
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

/**
 * The response gate. The model's manifest is treated as advisory: a
 * mismatch between what it claims and what the request supplied (a source
 * id, a runtime import, an interaction count) is logged, not fatal -- the
 * compiler and the static validator are what actually decide whether the
 * generated *code* is safe to run. The two identity digests are still
 * asserted; they are server-authored and free to check.
 */
export function validateUiGenerationResponseForRequest(request: UiGenerationRequest, value: unknown): UiGenerationResponse {
  const response = UiGenerationResponseSchema.parse(value);
  const trustedSourceIds = new Set(request.trustedSources.map((source) => source.sourceId));
  const runtimeExports = new Set(request.runtime.exports);
  const advisories = [
    ...response.manifest.sourceIds.filter((id) => !trustedSourceIds.has(id)).map((id) => `unknown sourceId ${id}`),
    ...response.manifest.runtimeImports.filter((name) => !runtimeExports.has(name)).map((name) => `unavailable runtime import ${name}`),
    ...(response.manifest.localInteractions.length > request.limits.maxLocalStateEntries ? ["local interaction count over limit"] : []),
  ];
  if (advisories.length > 0) {
    console.warn("[generated-ui] manifest advisories (not fatal):", advisories.join("; "));
  }
  if (response.promptDigest !== request.promptDigest) throw new Error("response prompt digest does not match request");
  if (response.inputDigest !== digestUiGenerationRequest(request)) throw new Error("response input digest does not match canonical request");
  return response;
}
