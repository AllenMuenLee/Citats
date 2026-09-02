import { describe, expect, it, vi } from "vitest";
import { UI_GENERATE_PROGRESS_STATES, type UiGenerateProgressState } from "@ai-browser/contracts";
import { createUiGeneratePipeline } from "../../src/server/ui-generate/pipeline";
import { UiGenerateStageError, type RegisteredView, type UiGenerateContext } from "../../src/server/ui-generate/types";
import { validUiPlan } from "../helpers/ui-plan";

const view: RegisteredView = {
  instanceId: "instance-1",
  viewRef: "uiv_abcdefgh",
  artifactId: `gui_${"a".repeat(64)}`,
  planDigest: "b".repeat(64),
  inputDigest: "c".repeat(64),
  revision: 0,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  title: "Grinder comparison",
  sourceCount: 1,
  coverage: "validated",
  fallbackText: "Generated view unavailable.",
};

function harness(overrides: Partial<Parameters<typeof createUiGeneratePipeline>[0]> = {}) {
  const order: string[] = [];
  const progress: UiGenerateProgressState[] = [];
  const emitted: RegisteredView[] = [];
  const destroyed: string[] = [];
  const controller = new AbortController();
  const dependencies = {
    sourceFinding: {
      find: vi.fn(async () => {
        order.push("source_finding");
        return [{ sourceId: "src-1", url: "https://example.com/", origin: "https://example.com", reason: "r" }];
      }),
    },
    capture: {
      capture: vi.fn(async () => {
        order.push("page_capture");
        return {
          captures: [
            {
              sourceId: "src-1",
              requestedUrl: "https://example.com/",
              finalUrl: "https://example.com/",
              origin: "https://example.com",
              title: "t",
              contentType: "text/html",
              retrievedAt: new Date().toISOString(),
              retrievalMs: 5,
              html: "<html></html>",
              truncated: false,
            },
          ],
          failures: [],
        };
      }),
    },
    planning: {
      plan: vi.fn(async () => {
        order.push("ui_planning");
        return validUiPlan();
      }),
    },
    generation: {
      generate: vi.fn(async () => {
        order.push("ui_generation");
        return view;
      }),
    },
    render: {
      awaitReady: vi.fn(async () => {
        order.push("rendering");
        return true;
      }),
      destroy: vi.fn(({ instanceId }: { instanceId: string }) => {
        destroyed.push(instanceId);
      }),
    },
    ...overrides,
  };
  const context: UiGenerateContext = {
    correlationId: "req-1",
    ownerId: "owner-1",
    sessionId: "session-1",
    invocationId: "call-1",
    signal: controller.signal,
    emitProgress: (state) => progress.push(state),
    emitView: (value) => emitted.push(value),
  };
  return { dependencies, context, order, progress, emitted, destroyed, controller };
}

describe("ui.generate pipeline", () => {
  it("runs the stages in exactly the hardcoded order", async () => {
    const { dependencies, context, order } = harness();
    const generate = createUiGeneratePipeline(dependencies as never);
    await generate("compare grinders", context);
    expect(order).toEqual(["source_finding", "page_capture", "ui_planning", "ui_generation", "rendering"]);
  });

  it("emits every progress state once, in contract order", async () => {
    const { dependencies, context, progress } = harness();
    await createUiGeneratePipeline(dependencies as never)("compare grinders", context);
    expect(progress).toEqual([...UI_GENERATE_PROGRESS_STATES]);
  });

  it("returns ready only after a real handshake, with an opaque reference and safe metadata", async () => {
    const { dependencies, context } = harness();
    const result = await createUiGeneratePipeline(dependencies as never)("compare grinders", context);
    expect(result).toEqual({ status: "ready", viewRef: view.viewRef, title: view.title, sourceCount: 1, coverage: "validated" });
    // Nothing about the artifact, plan, prompt, or source HTML crosses back.
    expect(JSON.stringify(result)).not.toContain("gui_");
    expect(JSON.stringify(result)).not.toContain("example.com");
  });

  it("fails and tears down the surface when the handshake never arrives", async () => {
    const { dependencies, context, destroyed, emitted } = harness({
      render: { awaitReady: vi.fn(async () => false), destroy: vi.fn() },
    });
    const result = await createUiGeneratePipeline(dependencies as never)("compare grinders", context);
    expect(result).toMatchObject({ status: "failed", category: "render_failed" });
    // The view was handed to the renderer, but that is not readiness.
    expect(emitted).toHaveLength(1);
    expect(dependencies.render.destroy).toHaveBeenCalledWith({ instanceId: "instance-1", ownerId: "owner-1" });
    expect(destroyed).toEqual([]);
  });

  it.each([
    ["no_sources", "sourceFinding", "find"],
    ["capture_failed", "capture", "capture"],
    ["planning_failed", "planning", "plan"],
    ["generation_failed", "generation", "generate"],
  ] as const)("maps a %s stage failure onto that closed category", async (category, stage, method) => {
    const { dependencies, context } = harness();
    (dependencies as unknown as Record<string, Record<string, unknown>>)[stage]![method] = vi.fn(async () => {
      throw new UiGenerateStageError(category, "stage failed");
    });
    const result = await createUiGeneratePipeline(dependencies as never)("compare grinders", context);
    expect(result).toMatchObject({ status: "failed", category });
  });

  it("never leaks an unexpected error's message into the result", async () => {
    const { dependencies, context } = harness();
    dependencies.planning.plan = vi.fn(async () => {
      throw new Error("provider said: <secret page content>");
    });
    const result = await createUiGeneratePipeline(dependencies as never)("compare grinders", context);
    expect(result).toMatchObject({ status: "failed", category: "internal" });
    expect(JSON.stringify(result)).not.toContain("secret page content");
  });

  it("returns exactly one terminal result and stops early when cancelled", async () => {
    const { dependencies, context, controller, order } = harness();
    controller.abort();
    const result = await createUiGeneratePipeline(dependencies as never)("compare grinders", context);
    expect(result).toMatchObject({ status: "failed", category: "cancelled" });
    expect(order).toEqual([]);
  });
});
