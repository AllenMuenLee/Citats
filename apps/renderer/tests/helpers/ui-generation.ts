import {
  UiGenerationRequestSchema,
  digestImplementationPrompt,
  type TrustedGenerationSource,
  type UiGenerationRequest,
} from "@ai-browser/contracts";
import {
  GENERATED_UI_ALLOWED_TOKENS,
  GENERATED_UI_LIMITS,
  GENERATED_UI_RUNTIME_API_VERSION,
  GENERATED_UI_RUNTIME_EXPORTS,
} from "../../src/server/generative-ui/request-builder";
import { UI_GENERATION_PROMPT_DIGEST, UI_GENERATION_PROMPT_VERSION } from "../../src/server/generative-ui/system-prompt";
import { UI_PLANNING_PROMPT_DIGEST, UI_PLANNING_PROMPT_VERSION } from "../../src/server/ui-generate/planning/system-prompt";

export const SAMPLE_IMPLEMENTATION_PROMPT =
  "Build a single-column comparison of two coffee grinders. Open with a one-sentence summary, then a " +
  "two-row table with Price and Rating columns, every figure attributed to src-1 in visible text. Use " +
  "the accent token for the summary rule, surface for the table. Collapse to stacked cards below 800px. " +
  "Provide a sort-by-price/rating control with two options. Include empty, loading, error, and partial copy.";

export const SAMPLE_TRUSTED_SOURCES: readonly TrustedGenerationSource[] = [
  {
    sourceId: "src-1",
    finalUrl: "https://example.com/grinders",
    origin: "example.com",
    title: "Grinder round-up",
    retrievedAt: "2026-09-02T10:00:00.000Z",
    captureStatus: "complete",
  },
];

/** A minimal but fully valid `UiGenerationRequest`. Mutate one field per test. */
export function validUiGenerationRequest(overrides: Partial<UiGenerationRequest> = {}): UiGenerationRequest {
  const implementationPrompt = overrides.implementationPrompt ?? SAMPLE_IMPLEMENTATION_PROMPT;
  return UiGenerationRequestSchema.parse({
    schemaVersion: 1,
    plannerPromptVersion: UI_PLANNING_PROMPT_VERSION,
    plannerPromptDigest: UI_PLANNING_PROMPT_DIGEST,
    promptVersion: UI_GENERATION_PROMPT_VERSION,
    promptDigest: UI_GENERATION_PROMPT_DIGEST,
    trustedRequest: "Compare two coffee grinders",
    implementationPrompt,
    implementationPromptDigest: digestImplementationPrompt(implementationPrompt),
    trustedSources: SAMPLE_TRUSTED_SOURCES,
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
    correlation: { requestId: "req-1", userId: "user-1" },
    ...overrides,
  });
}
