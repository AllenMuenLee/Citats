import { z } from "zod";
import { HttpUrlSchema } from "../primitives";
import { ToolDefinitionSchema } from "../tool-definition";
import {
  ExtractedChunkSchema,
  ExtractionTruncationSchema,
  ExtractionWarningSchema,
  MAX_EXTRACTED_CHUNKS,
  NavigateAndExtractMetadataSchema,
  NavigateAndExtractTimingSchema,
} from "./navigate-and-extract";
import { ActionAffordanceSchema } from "./action-affordance";

/**
 * `browser.navigate_extract_and_discover` -- Phase 3 (P03-F05) trusted,
 * server-owned tool. Composes exactly one navigation with network capture
 * (`services/browser/src/browser_service/discovery/service.py`), content
 * extraction, endpoint-map inference/conservative auto-activation, and DOM
 * affordance correlation, and returns two separate bounded sections: the
 * read-only page `document` (same shape `browser.navigate_and_extract`
 * returns, plus descriptive-only interactive affordances) and `discovery`
 * (sanitized observation counts, candidate/active map versions, typed
 * read-only operation handles, and closed action-affordance descriptors).
 *
 * URL + a bounded free-text `goal` are the only inputs -- the model and
 * renderer never control CDP domains, capture filters, headers, cookies,
 * activation, or persistence policy (P03-F05 step 2).
 */
export const NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME =
  "browser.navigate_extract_and_discover" as const;

export const NAVIGATE_EXTRACT_AND_DISCOVER_GOAL_MAX_LENGTH = 500;

export const NavigateExtractAndDiscoverArgsSchema = z
  .object({
    url: HttpUrlSchema,
    goal: z.string().max(NAVIGATE_EXTRACT_AND_DISCOVER_GOAL_MAX_LENGTH).optional(),
  })
  .strict();

export type NavigateExtractAndDiscoverArgs = z.infer<typeof NavigateExtractAndDiscoverArgsSchema>;

export const AFFORDANCE_ID_MAX_LENGTH = 64;
export const AFFORDANCE_LABEL_MAX_LENGTH = 200;

/** Mirrors `browser_service.extraction.models.AffordanceRole`. */
export const AffordanceRoleSchema = z.enum(["link", "button", "form"]);
export type AffordanceRole = z.infer<typeof AffordanceRoleSchema>;

/**
 * A bounded, descriptive-only record of one visible interactive element:
 * what it is, never how to operate it. No selector, DOM path, script, or
 * form field value ever appears here -- mirrors
 * `browser_service.extraction.models.Affordance`.
 */
export const AffordanceSchema = z
  .object({
    affordanceId: z.string().min(1).max(AFFORDANCE_ID_MAX_LENGTH),
    role: AffordanceRoleSchema,
    label: z.string().min(1).max(AFFORDANCE_LABEL_MAX_LENGTH),
    destination: HttpUrlSchema.nullable(),
    disabled: z.boolean(),
  })
  .strict();

export type Affordance = z.infer<typeof AffordanceSchema>;

export const MAX_AFFORDANCES = 100;

/** Same shape `browser.navigate_and_extract` returns, plus bounded affordances. */
export const NavigateExtractAndDiscoverDocumentSchema = z
  .object({
    metadata: NavigateAndExtractMetadataSchema,
    chunks: z.array(ExtractedChunkSchema).max(MAX_EXTRACTED_CHUNKS),
    affordances: z.array(AffordanceSchema).max(MAX_AFFORDANCES),
    warnings: z.array(ExtractionWarningSchema).max(100),
    truncations: z.array(ExtractionTruncationSchema).max(50),
    timing: NavigateAndExtractTimingSchema,
    untrusted: z.literal(true),
  })
  .strict();

export type NavigateExtractAndDiscoverDocument = z.infer<
  typeof NavigateExtractAndDiscoverDocumentSchema
>;

/**
 * Opaque, typed handle for one active or newly-active read-only operation
 * -- the same shape the orchestrator turns into a dynamic `discovered.*`
 * tool definition (see `apps/renderer/src/server/orchestrator/registry.ts`'s
 * `createDiscoveredOperationTool`). Never carries a URL, header, or cookie.
 */
export const DiscoveredOperationHandleSchema = z
  .object({
    siteId: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
    operationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    method: z.enum(["GET", "HEAD"]),
    resultKind: z.enum(["product_results", "flight_comparison", "generic_records"]),
    // Exact shape `DiscoveredApiInvoker.definitions()` (Python) produces and
    // `DiscoveredToolSchema` (`server/browser-service/client.ts`) expects --
    // a bounded JSON-Schema-object describing this operation's logical
    // parameters, never an executable URL/header/cookie.
    parameters: z
      .object({
        type: z.literal("object"),
        additionalProperties: z.literal(false),
        properties: z.record(z.string(), z.unknown()),
        required: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type DiscoveredOperationHandle = z.infer<typeof DiscoveredOperationHandleSchema>;

export const DRIFT_ALERT_REASON_MAX_LENGTH = 200;

export const DriftAlertSchema = z
  .object({
    operationId: z.string().min(1).max(128),
    kinds: z
      .array(
        z.enum([
          "removed",
          "status_changed",
          "content_type_changed",
          "parameter_incompatible",
          "response_incompatible",
        ]),
      )
      .min(1)
      .max(10),
  })
  .strict();

export type DriftAlert = z.infer<typeof DriftAlertSchema>;

export const MAX_DISCOVERED_OPERATIONS = 50;
export const MAX_ACTION_AFFORDANCES = 50;
export const MAX_DRIFT_ALERTS = 50;
export const MAX_DISCOVERY_WARNINGS = 50;
export const DISCOVERY_WARNING_MAX_LENGTH = 300;

export const NavigateExtractAndDiscoverDiscoverySchema = z
  .object({
    observationCount: z.number().int().nonnegative(),
    operationCount: z.number().int().nonnegative(),
    candidateMapVersion: z.string().min(1).max(128),
    activeMapVersion: z.string().min(1).max(128).nullable(),
    operations: z.array(DiscoveredOperationHandleSchema).max(MAX_DISCOVERED_OPERATIONS),
    actions: z.array(ActionAffordanceSchema).max(MAX_ACTION_AFFORDANCES),
    driftAlerts: z.array(DriftAlertSchema).max(MAX_DRIFT_ALERTS),
    warnings: z.array(z.string().min(1).max(DISCOVERY_WARNING_MAX_LENGTH)).max(MAX_DISCOVERY_WARNINGS),
  })
  .strict();

export type NavigateExtractAndDiscoverDiscovery = z.infer<
  typeof NavigateExtractAndDiscoverDiscoverySchema
>;

export const NavigateExtractAndDiscoverResultSchema = z
  .object({
    document: NavigateExtractAndDiscoverDocumentSchema,
    discovery: NavigateExtractAndDiscoverDiscoverySchema,
  })
  .strict();

export type NavigateExtractAndDiscoverResult = z.infer<
  typeof NavigateExtractAndDiscoverResultSchema
>;

export const NavigateExtractAndDiscoverToolDefinition = ToolDefinitionSchema.parse({
  contractVersion: 1,
  name: NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME,
  description:
    "Navigates to a public http(s) URL, reads bounded page content, and observes the page's own " +
    "read-only network traffic to surface newly available read-only API operations for this " +
    "session. Read-only: never fills forms, clicks, submits, or executes any mutating request. " +
    "Any action-affordance it reports is informational only and is never itself callable.",
  argsSchemaVersion: 1,
  argsSchemaRef: "browser.navigate_extract_and_discover.v1",
  sensitiveByDefault: false,
});
