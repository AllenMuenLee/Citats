import "server-only";

import type { AiConfig } from "../ai/config";
import { createTextCompletion } from "../ai";
import { generatedUiInstances, type GeneratedUiInstanceStore } from "../generative-ui/instance-store";
import { createCaptureStage, createSharedChromiumProvider, type BrowserProvider } from "./capture/playwright-capture";
import { createGenerationStage, createRenderStage } from "./generation/generation-stage";
import { createPlanningStage } from "./planning/plan-adapter";
import { createSourceFindingStage } from "./source-finding/source-finder";
import { createUiGeneratePipeline, type UiGeneratePipeline } from "./pipeline";

export * from "./types";
export { createUiGeneratePipeline, type UiGeneratePipeline } from "./pipeline";
export { buildSourceFindingPrompt, createSourceFindingStage, MAX_SOURCE_CANDIDATES } from "./source-finding/source-finder";
export {
  assertPublicDestination,
  isPrivateAddress,
  normalizeCandidateUrl,
  readSourceOriginPolicy,
  validateCandidateUrls,
  type SourceOriginPolicy,
  type UrlDecision,
  type UrlRejectionReason,
} from "./source-finding/url-policy";
export { createCaptureStage, createSharedChromiumProvider, DEFAULT_CAPTURE_BOUNDS } from "./capture/playwright-capture";
export { buildPlannerInput, createPlanningStage } from "./planning/plan-adapter";
export { UI_PLANNING_PROMPT_VERSION, UI_PLANNING_SYSTEM_PROMPT } from "./planning/system-prompt";
export { createGenerationStage, createRenderStage } from "./generation/generation-stage";

/**
 * Assembles the fixed pipeline from the configured model roles.
 *
 * Returns `null` unless all three internal roles are configured. A tool
 * that is offered and then fails every call is worse than a tool that is
 * not offered: the model spends its turn on it and the user gets a failure
 * where a text answer was available.
 */
export function createUiGenerateFromConfig(options: {
  ai: AiConfig;
  instances?: GeneratedUiInstanceStore;
  browserProvider?: BrowserProvider;
  log?: (line: Record<string, unknown>) => void;
}): UiGeneratePipeline | null {
  const { sourceFinding, uiPlanning, ui } = options.ai;
  if (!sourceFinding || !uiPlanning || !ui) return null;
  const instances = options.instances ?? generatedUiInstances;
  const log = options.log ?? ((line: Record<string, unknown>) => console.info("[ui.generate]", line));
  return createUiGeneratePipeline({
    sourceFinding: createSourceFindingStage({ model: sourceFinding.model, transport: createTextCompletion(sourceFinding), log }),
    capture: createCaptureStage({ browserProvider: options.browserProvider ?? createSharedChromiumProvider(), log }),
    planning: createPlanningStage({ model: uiPlanning.model, transport: createTextCompletion(uiPlanning), log }),
    generation: createGenerationStage({ role: ui, instances, log }),
    render: createRenderStage(instances),
  });
}
