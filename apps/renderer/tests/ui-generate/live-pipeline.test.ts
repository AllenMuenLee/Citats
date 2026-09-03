import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { describe, expect, it } from "vitest";

/**
 * End-to-end exercise of the real `ui.generate` pipeline against the
 * configured providers and a live headless capture. It is opt-in -- it
 * spends real model quota and reaches the public internet -- so it only
 * runs when `LIVE_UI_GENERATE=1`. Point it at a request with
 * `LIVE_UI_GENERATE_REQUEST`; artifacts land in a fresh temp dir printed at
 * startup.
 */
const RUN = process.env.LIVE_UI_GENERATE === "1";

loadEnv({ path: new URL("../../.env", import.meta.url) });

import { readAiConfig } from "../../src/server/ai/config";
import { createTextCompletion } from "../../src/server/ai";
import { createSourceFindingStage } from "../../src/server/ui-generate/source-finding/source-finder";
import { createCaptureStage, createSharedChromiumProvider } from "../../src/server/ui-generate/capture/playwright-capture";
import { createPlanningStage, buildPlannerInput } from "../../src/server/ui-generate/planning/plan-adapter";
import { UI_PLANNING_PROMPT_VERSION, UI_PLANNING_PROMPT_DIGEST } from "../../src/server/ui-generate/planning/system-prompt";
import { buildUiGenerationRequest } from "../../src/server/generative-ui/request-builder";
import { createUiGenerationAdapter } from "../../src/server/generative-ui/ui-adapter";
import {
  GENERATED_UI_TOOLCHAIN_VERSION,
  GeneratedUiCompilationError,
  compileGeneratedUi,
  validateGeneratedUiSource,
} from "../../src/server/generative-ui/compiler";

const REQUEST =
  process.env.LIVE_UI_GENERATE_REQUEST ??
  "find 6 airbnb listings in seattle that's available from sep 4 to 6, and generate a UI for me to compare them";

const log = (line: Record<string, unknown>) => console.info("[stage]", JSON.stringify(line));

describe.runIf(RUN)("live ui.generate pipeline", () => {
  it(
    "produces a validated, compiled React component",
    async () => {
      const out = mkdtempSync(join(tmpdir(), "ui-generate-live-"));
      console.info("[out]", out);
      const ai = readAiConfig();
      if (!ai.sourceFinding || !ai.uiPlanning || !ai.ui) throw new Error("ui.generate roles not fully configured");

      const signal = new AbortController().signal;
      const correlationId = "live-pipeline";

      const sources = await createSourceFindingStage({
        model: ai.sourceFinding.model,
        transport: createTextCompletion(ai.sourceFinding),
        log,
      }).find({ request: REQUEST, correlationId, signal });
      console.info("[sources]", JSON.stringify(sources, null, 2));
      expect(sources.length).toBeGreaterThan(0);

      const { captures, failures } = await createCaptureStage({
        browserProvider: createSharedChromiumProvider(),
        log,
      }).capture({ sources, correlationId, signal });
      console.info("[captures]", JSON.stringify({ captured: captures.map((c) => c.finalUrl), failures }, null, 2));
      captures.forEach((c, i) => writeFileSync(join(out, `capture-${i + 1}.html`), c.html));
      expect(captures.length).toBeGreaterThan(0);

      writeFileSync(join(out, "planner-input.txt"), buildPlannerInput(REQUEST, captures));
      const plan = await createPlanningStage({
        model: ai.uiPlanning.model,
        transport: createTextCompletion(ai.uiPlanning),
        log,
      }).plan({ request: REQUEST, captures, correlationId, signal });
      writeFileSync(join(out, "implementation-prompt.txt"), plan.implementationPrompt);

      const request = buildUiGenerationRequest({
        implementationPrompt: plan.implementationPrompt,
        trustedRequest: REQUEST,
        trustedSources: plan.trustedSources,
        plannerPromptVersion: UI_PLANNING_PROMPT_VERSION,
        plannerPromptDigest: UI_PLANNING_PROMPT_DIGEST,
        requestId: correlationId,
        userId: "live-user",
      });

      const adapter = createUiGenerationAdapter({
        model: ai.ui.model,
        compilerVersion: GENERATED_UI_TOOLCHAIN_VERSION,
        maxTokens: ai.ui.provider === "groq" ? 8_000 : 24_000,
        transport: createTextCompletion(ai.ui),
        emitMetric: (m) => console.info("[ui-metric]", JSON.stringify(m)),
        validate: async (response) => {
          if (!response.tsxSource) return [];
          const input = {
            source: response.tsxSource,
            manifest: response.manifest,
            limits: request.limits,
            allowedTokens: request.theme.allowedTokens,
          };
          const staticErrors = validateGeneratedUiSource(input).issues.filter((i) => i.severity === "error");
          if (staticErrors.length > 0) return staticErrors;
          try {
            compileGeneratedUi(input);
            return [];
          } catch (error) {
            if (error instanceof GeneratedUiCompilationError) {
              return error.codes.map((code, i) => ({ code, ...(error.details[i] ? { message: error.details[i] } : {}) }));
            }
            throw error;
          }
        },
      });

      const response = await adapter.generate(request, signal);
      if (response.tsxSource) writeFileSync(join(out, "generated-view.tsx"), response.tsxSource);
      expect(response.tsxSource, `fallbackReason=${response.fallbackReason}`).toBeTruthy();

      const compiled = compileGeneratedUi({
        source: response.tsxSource!,
        manifest: response.manifest,
        limits: request.limits,
        allowedTokens: request.theme.allowedTokens,
      });
      writeFileSync(join(out, "compiled-view.js"), Buffer.from(compiled.bytes).toString("utf8"));
      expect(compiled.bytes.length).toBeGreaterThan(0);
      console.info("[SUCCESS]", { out, bytes: compiled.bytes.length });
    },
    600_000,
  );
});
