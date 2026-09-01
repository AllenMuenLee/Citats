import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpUrlSchema, IsoDateTimeSchema } from "../primitives";
import { CapabilityArgumentSchema, CapabilityPromptTemplateSchema, MAX_CAPABILITY_ARGUMENTS } from "./capability";
import { ObservationStatusSchema, OpaqueHandleSchema } from "./common";
import { CoverageReportSchema } from "./page-understanding";

/**
 * `WebsiteUiMetadata` (P03-F05 steps 6-7): the machine-readable companion
 * to the extraction model's free-form UI implementation prompt.
 *
 * The implementation prompt is deliberately unstructured prose -- it is the
 * plan, and validating its headings or wording would only reject useful
 * plans. Everything a later stage must actually *check* lives here instead,
 * as a versioned JSON artifact with a canonical serialization and a digest:
 * source identity, provenance, freshness, coverage, the record/media ids
 * the plan may reference, and the two interaction declarations.
 *
 * The split is the point. Phase 4 validates identifiers, bounds, and
 * capability declarations against this artifact, and passes the prose
 * through untouched as untrusted typed input.
 *
 * Nothing here is executable and nothing here is secret: no selector,
 * script, cookie, credential, authorization material, captured payment
 * field, or private form value ever appears. Payment and identity are
 * represented only by an opaque browser-held profile handle plus the field
 * requirements a user must confirm.
 */
export const WEBSITE_UI_METADATA_VERSION = 1 as const;

export const MAX_WEBSITE_UI_RECORD_IDS = 256;
export const MAX_WEBSITE_UI_MEDIA_IDS = 256;
export const MAX_WEBSITE_UI_INTERNAL_INTERACTIONS = 32;
export const MAX_WEBSITE_UI_EXTERNAL_CAPABILITIES = 32;
export const MAX_WEBSITE_UI_WARNINGS = 32;

export const WebsiteUiFreshnessSchema = z.enum(["live", "cached", "unknown"]);

/**
 * One interaction the generated component runs entirely as React state over
 * data it was already given. It has no capability arguments and no prompt
 * template, because nothing leaves the sandbox when it runs.
 */
export const WebsiteUiInternalInteractionSchema = z
  .object({
    capabilityId: OpaqueHandleSchema,
    kind: z.enum(["selection", "filter", "sort", "expansion", "tab", "gallery", "modal"]),
    label: z.string().min(1).max(200),
    /** Upper bound on the distinct values this interaction may hold, so local state stays bounded. */
    boundedValues: z.number().int().positive().max(10_000),
  })
  .strict();

export type WebsiteUiInternalInteraction = z.infer<typeof WebsiteUiInternalInteractionSchema>;

/**
 * One interaction that would affect the real website. The generated
 * component may emit only `capabilityId` + `promptTemplateId` + arguments
 * valid against `argumentSchema`; the trusted server holds the template
 * text and reconstructs the AI action prompt itself.
 */
export const WebsiteUiExternalCapabilitySchema = z
  .object({
    capabilityId: OpaqueHandleSchema,
    promptTemplateId: OpaqueHandleSchema,
    intent: z.string().min(1).max(200),
    effectClass: z.enum(["navigation", "data_entry", "submission", "download", "media", "external_application", "unknown"]),
    /**
     * The validated intent text the trusted server fills in and sends to
     * the later action agent. `{{argumentName}}` placeholders resolve
     * against `argumentSchema`; the generated component supplies only the
     * arguments, never this string.
     */
    promptTemplate: CapabilityPromptTemplateSchema,
    argumentSchema: z.array(CapabilityArgumentSchema).max(MAX_CAPABILITY_ARGUMENTS),
    /** Origin only, never a full URL with path or query. */
    destinationOrigin: z.string().max(255).nullable(),
    /** True whenever activating this would spend money, book, or otherwise commit the user. */
    requiresConfirmation: z.boolean(),
    /**
     * The opaque browser-held profile handle a later phase would draw
     * payment/identity details from. Never the details themselves -- the
     * model and the generated UI never receive a card number, password,
     * cookie, or autofill value.
     */
    paymentProfileHandle: OpaqueHandleSchema.nullable(),
    /** Field *names* the user must confirm before a later phase may proceed. */
    confirmationFields: z.array(z.string().min(1).max(100)).max(12),
  })
  .strict();

export type WebsiteUiExternalCapability = z.infer<typeof WebsiteUiExternalCapabilitySchema>;

export const WebsiteUiProvenanceSchema = z
  .object({
    sourceUrl: HttpUrlSchema,
    origin: z.string().min(1).max(255),
    retrievedAt: IsoDateTimeSchema,
    observationStatus: ObservationStatusSchema,
  })
  .strict();

export const WebsiteUiPageMetadataSchema = z
  .object({
    title: z.string().max(500).nullable(),
    language: z.string().max(35).nullable(),
    description: z.string().max(1_000).nullable(),
    author: z.string().max(300).nullable(),
    publishedTime: z.string().max(64).nullable(),
    updatedTime: z.string().max(64).nullable(),
    siteName: z.string().max(300).nullable(),
    pageType: z.string().max(100).nullable(),
  })
  .strict();

export const WebsiteUiMetadataSchema = z
  .object({
    schemaVersion: z.literal(WEBSITE_UI_METADATA_VERSION),
    observationId: OpaqueHandleSchema,
    observationDigest: z.string().min(1).max(128),
    page: WebsiteUiPageMetadataSchema,
    provenance: WebsiteUiProvenanceSchema,
    freshness: WebsiteUiFreshnessSchema,
    coverage: CoverageReportSchema,
    warnings: z.array(z.string().max(300)).max(MAX_WEBSITE_UI_WARNINGS),
    recordIds: z.array(OpaqueHandleSchema).max(MAX_WEBSITE_UI_RECORD_IDS),
    mediaIds: z.array(OpaqueHandleSchema).max(MAX_WEBSITE_UI_MEDIA_IDS),
    internalInteractions: z.array(WebsiteUiInternalInteractionSchema).max(MAX_WEBSITE_UI_INTERNAL_INTERACTIONS),
    externalCapabilities: z.array(WebsiteUiExternalCapabilitySchema).max(MAX_WEBSITE_UI_EXTERNAL_CAPABILITIES),
    /** Always `true`: every value here derives from untrusted page content. */
    untrusted: z.literal(true),
  })
  .strict()
  .superRefine((metadata, ctx) => {
    const duplicate = (values: readonly string[], path: string) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: "custom", path: [path], message: `${path} must be unique` });
      }
    };
    duplicate(metadata.recordIds, "recordIds");
    duplicate(metadata.mediaIds, "mediaIds");
    duplicate(metadata.internalInteractions.map((item) => item.capabilityId), "internalInteractions");
    duplicate(metadata.externalCapabilities.map((item) => item.capabilityId), "externalCapabilities");
    duplicate(metadata.externalCapabilities.map((item) => item.promptTemplateId), "externalCapabilities");
    for (const capability of metadata.externalCapabilities) {
      const declared = new Set(capability.argumentSchema.map((argument) => argument.name));
      for (const placeholder of capability.promptTemplate.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
        if (!declared.has(placeholder[1]!)) {
          ctx.addIssue({ code: "custom", path: ["externalCapabilities"], message: `prompt template references undeclared argument ${placeholder[1]}` });
        }
      }
    }
    const internal = new Set(metadata.internalInteractions.map((item) => item.capabilityId));
    for (const capability of metadata.externalCapabilities) {
      if (internal.has(capability.capabilityId)) {
        ctx.addIssue({ code: "custom", path: ["externalCapabilities"], message: `capability ${capability.capabilityId} is declared both internal and external` });
      }
    }
  });

export type WebsiteUiMetadata = z.infer<typeof WebsiteUiMetadataSchema>;

/**
 * Canonical serialization: keys sorted, arrays whose order carries no
 * meaning sorted too, so an identical artifact always digests identically
 * regardless of how it was assembled.
 */
const UNORDERED_KEYS = new Set(["warnings", "recordIds", "mediaIds", "internalInteractions", "externalCapabilities", "confirmationFields", "argumentSchema", "notes"]);

function canonicalize(value: unknown, key?: string): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    return UNORDERED_KEYS.has(key ?? "") ? [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : items;
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

export function canonicalizeWebsiteUiMetadata(metadata: WebsiteUiMetadata): string {
  return JSON.stringify(canonicalize(WebsiteUiMetadataSchema.parse(metadata)));
}

export function digestWebsiteUiMetadata(metadata: WebsiteUiMetadata): string {
  return createHash("sha256").update(canonicalizeWebsiteUiMetadata(metadata), "utf8").digest("hex");
}
