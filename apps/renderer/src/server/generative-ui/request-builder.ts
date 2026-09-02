import {
  UiGenerationRequestSchema,
  digestUiPlan,
  type UiGenerationRequest,
  type UiPlan,
} from "@ai-browser/contracts";
import { UI_GENERATION_PROMPT_DIGEST, UI_GENERATION_PROMPT_VERSION } from "./system-prompt";

export const GENERATED_UI_RUNTIME_API_VERSION = "2.0.0";

/**
 * The semantic tokens a generated view may name, and the same list the
 * planning model is given. These mirror the theme table in
 * `docs/desktop-architecture-and-ui-specification.md`; a token outside this
 * set is rejected by the request schema, the static validator, and the
 * plan's own visual direction check.
 */
export const GENERATED_UI_ALLOWED_TOKENS: readonly string[] = Object.freeze([
  "canvas",
  "surface",
  "elevated",
  "text-primary",
  "text-secondary",
  "border",
  "accent",
  "accent-hover",
  "success",
  "warning",
  "danger",
  "focus",
  "space-4",
  "space-8",
  "space-12",
  "space-16",
  "space-24",
  "space-32",
  "radius-control",
  "radius-panel",
  "radius-overlay",
]);

/** The runtime exports offered to one generation. Server-owned; the model cannot extend it. */
export const GENERATED_UI_RUNTIME_EXPORTS: readonly string[] = Object.freeze([
  "GeneratedViewProps", "OpaqueId", "DisplaySource", "DisplayFact", "DisplayRecord", "DisplayRecordField",
  "DisplayCollection", "DisplayMedia", "DisplayCoverage", "semanticTokens",
  "Stack", "Inline", "Grid", "Card", "Region", "Text", "Heading", "Badge", "List", "ListItem",
  "Table", "TableHead", "TableBody", "TableRow", "TableHeader", "TableCell",
  "Label", "Select", "Option", "Status", "Warning", "Source", "Freshness", "Icon", "Media", "Modal",
  "useBoundedState", "useLocalCollection", "formatNumber", "formatCurrency", "formatDate",
]);

export const GENERATED_UI_LIMITS = Object.freeze({
  maxSourceBytes: 65_536,
  maxAstNodes: 20_000,
  maxComplexity: 200,
  maxRenderNodes: 5_000,
  maxLocalStateEntries: 24,
});

/**
 * Builds the closed Phase 4 generation request from a validated `UiPlan`.
 *
 * The plan is the only variable input. Everything else here -- prompt
 * identity, runtime, theme, limits -- is fixed server policy, which is what
 * makes the request digest a usable cache key and what stops a plan from
 * widening its own envelope.
 */
export function buildUiGenerationRequest(input: {
  plan: UiPlan;
  requestId: string;
  userId: string;
}): UiGenerationRequest {
  return UiGenerationRequestSchema.parse({
    schemaVersion: 1,
    promptVersion: UI_GENERATION_PROMPT_VERSION,
    promptDigest: UI_GENERATION_PROMPT_DIGEST,
    plan: input.plan,
    planDigest: digestUiPlan(input.plan),
    runtime: {
      module: "@ai-browser/generated-ui-runtime",
      apiVersion: GENERATED_UI_RUNTIME_API_VERSION,
      exports: [...GENERATED_UI_RUNTIME_EXPORTS],
    },
    theme: {
      allowedTokens: [...GENERATED_UI_ALLOWED_TOKENS],
      minimumTargetSize: 40,
      supportedThemes: ["light", "dark"],
      supportsReducedMotion: true,
      minimumViewport: { width: 800, height: 600 },
      maximumZoomPercent: 200,
    },
    limits: { ...GENERATED_UI_LIMITS },
    correlation: { requestId: input.requestId, userId: input.userId },
  });
}
