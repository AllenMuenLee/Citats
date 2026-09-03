import {
  UiGenerationRequestSchema,
  digestImplementationPrompt,
  type TrustedGenerationSource,
  type UiGenerationRequest,
} from "@ai-browser/contracts";
import { UI_GENERATION_PROMPT_DIGEST, UI_GENERATION_PROMPT_VERSION } from "./system-prompt";

export const GENERATED_UI_RUNTIME_API_VERSION = "3.0.0";

/**
 * The semantic tokens a generated view may name, and the same list the
 * planning model is given. These mirror the theme table in
 * `docs/desktop-architecture-and-ui-specification.md`; a token outside this
 * set is rejected by the request schema and the static validator.
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
  "GeneratedViewProps", "OpaqueId", "DisplaySource", "DisplayCoverage", "semanticTokens",
  "Stack", "Inline", "Grid", "Card", "Region", "Text", "Heading", "Badge", "List", "ListItem",
  "Table", "TableHead", "TableBody", "TableRow", "TableHeader", "TableCell",
  "Label", "Select", "Option", "Status", "Warning", "Source", "Freshness", "Icon", "Modal",
  "useBoundedState", "useLocalCollection", "formatNumber", "formatCurrency", "formatDate",
]);

export const GENERATED_UI_LIMITS = Object.freeze({
  maxSourceBytes: 65_536,
  maxAstNodes: 20_000,
  maxComplexity: 200,
  maxRenderNodes: 5_000,
  maxLocalStateEntries: 24,
});

export interface BuildUiGenerationRequestInput {
  /** The planner's free-form implementation prompt -- untrusted text, carried verbatim. */
  implementationPrompt: string;
  /** The trusted user request, for the display label and pane title. */
  trustedRequest: string;
  /** Trusted source records from the capture stage. */
  trustedSources: readonly TrustedGenerationSource[];
  /** Versioned planner policy identity. */
  plannerPromptVersion: string;
  plannerPromptDigest: string;
  requestId: string;
  userId: string;
}

/**
 * Builds the closed Phase 4 generation request.
 *
 * The implementation prompt and the trusted sources are the only variable
 * inputs. Everything else -- prompt identity for both policies, runtime,
 * theme, limits -- is fixed server policy, which is what makes the request
 * digest a usable cache key and what stops the model from widening its own
 * envelope.
 */
export function buildUiGenerationRequest(input: BuildUiGenerationRequestInput): UiGenerationRequest {
  return UiGenerationRequestSchema.parse({
    schemaVersion: 1,
    plannerPromptVersion: input.plannerPromptVersion,
    plannerPromptDigest: input.plannerPromptDigest,
    promptVersion: UI_GENERATION_PROMPT_VERSION,
    promptDigest: UI_GENERATION_PROMPT_DIGEST,
    trustedRequest: input.trustedRequest,
    implementationPrompt: input.implementationPrompt,
    implementationPromptDigest: digestImplementationPrompt(input.implementationPrompt),
    trustedSources: input.trustedSources,
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
