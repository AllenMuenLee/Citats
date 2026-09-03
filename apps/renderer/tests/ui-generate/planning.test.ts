import { describe, expect, it } from "vitest";

import type { TextCompletionRequest } from "../../src/server/ai/types";
import { createPlanningStage } from "../../src/server/ui-generate/planning/plan-adapter";
import { UI_PLANNING_SYSTEM_PROMPT } from "../../src/server/ui-generate/planning/system-prompt";

const capture = {
  sourceId: "src-1",
  requestedUrl: "https://example.com/grinders",
  finalUrl: "https://example.com/grinders",
  origin: "https://example.com",
  title: "Grinder round-up",
  contentType: "text/html",
  retrievedAt: "2026-09-02T10:00:00.000Z",
  retrievalMs: 10,
  html: "<main>Two grinders</main>",
  truncated: false,
};

describe("UI planning", () => {
  it("returns the model's free-form text and server-authored trusted sources, with no structured output", async () => {
    const requests: TextCompletionRequest[] = [];
    const stage = createPlanningStage({
      model: "gemini-3.5-flash-lite",
      transport: async (request) => {
        requests.push(request);
        return { model: request.model, content: "  Build a single-column comparison of the two grinders, attributing every figure to src-1.  " };
      },
    });

    const result = await stage.plan({
      request: "Compare two coffee grinders",
      correlationId: "correlation",
      signal: new AbortController().signal,
      captures: [capture],
    });

    expect(result.implementationPrompt).toBe("Build a single-column comparison of the two grinders, attributing every figure to src-1.");
    expect(result.trustedSources).toEqual([
      {
        sourceId: "src-1",
        finalUrl: "https://example.com/grinders",
        origin: "https://example.com",
        title: "Grinder round-up",
        retrievedAt: "2026-09-02T10:00:00.000Z",
        captureStatus: "complete",
      },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("responseFormat");
    expect(requests[0]!.systemInstruction).toBe(UI_PLANNING_SYSTEM_PROMPT);
    expect(UI_PLANNING_SYSTEM_PROMPT).toContain("implementation prompt");
    expect(UI_PLANNING_SYSTEM_PROMPT).toContain("Plain prose only");
  });

  it("fails the stage when the model returns no text", async () => {
    const stage = createPlanningStage({
      model: "m",
      transport: async (request) => ({ model: request.model, content: "   " }),
    });
    await expect(
      stage.plan({ request: "x", correlationId: "c", signal: new AbortController().signal, captures: [capture] }),
    ).rejects.toMatchObject({ category: "planning_failed" });
  });
});
