import { describe, expect, it, vi } from "vitest";

import {
  UI_GENERATE_TOOL_NAME,
  uiGenerateFailure,
  type UiGenerateResult,
} from "@ai-browser/contracts";
import type { ModelAdapter, ModelStreamEvent, ModelStreamRequest } from "../src/server/ai";
import { InMemoryConversationRepository } from "../src/server/conversation";
import { ChatOrchestrator, createToolRegistry, OrchestratorError, type OrchestratorEvent } from "../src/server/orchestrator";

const READY: UiGenerateResult = { status: "ready", viewRef: "uiv_abcdefgh", title: "Grinders", sourceCount: 2, coverage: "validated" };

/** A model that replays a scripted sequence of streams, one per step. */
function scriptedModel(steps: ModelStreamEvent[][]): ModelAdapter & { requests: ModelStreamRequest[] } {
  const requests: ModelStreamRequest[] = [];
  let index = 0;
  return {
    requests,
    async *stream(request: ModelStreamRequest) {
      requests.push(request);
      for (const event of steps[index] ?? []) yield event;
      index += 1;
    },
  };
}

function toolCall(name: string, args: string): ModelStreamEvent[] {
  return [{ type: "tool-call-delta", index: 0, id: "call-1", name, argumentsDelta: args }];
}

function text(value: string): ModelStreamEvent[] {
  return [{ type: "text-delta", text: value }];
}

async function collect(orchestrator: ChatOrchestrator, text_: string): Promise<OrchestratorEvent[]> {
  const events: OrchestratorEvent[] = [];
  for await (const event of orchestrator.run({ sessionId: "s1", ownerId: "owner", text: text_ })) events.push(event);
  return events;
}

function build(model: ModelAdapter, uiGenerate?: Parameters<typeof createToolRegistry>[0]["uiGenerate"]) {
  return new ChatOrchestrator({
    model,
    conversations: new InMemoryConversationRepository(),
    tools: createToolRegistry(uiGenerate ? { uiGenerate } : {}),
  });
}

describe("tool surface", () => {
  it("offers exactly one custom tool that takes no arguments", () => {
    const tools = createToolRegistry({ uiGenerate: vi.fn() });
    expect([...tools.keys()]).toEqual([UI_GENERATE_TOOL_NAME]);
    const definition = tools.get(UI_GENERATE_TOOL_NAME)!.definition;
    // A closed, empty parameter object: nothing for the model to fill in --
    // no request string, URL, site, HTML, model setting, code, or selector.
    expect(definition.parameters).toMatchObject({ type: "object", additionalProperties: false, properties: {} });
    expect(Object.keys((definition.parameters as { properties: Record<string, unknown> }).properties)).toEqual([]);
  });

  it("offers no tools at all when the pipeline is not configured", () => {
    expect([...createToolRegistry({}).keys()]).toEqual([]);
  });

  it("dispatches only an exact copy of the current user request", async () => {
    const seen: string[] = [];
    const uiGenerate = vi.fn(async (request: string) => {
      seen.push(request);
      return READY;
    });
    const model = scriptedModel([toolCall(UI_GENERATE_TOOL_NAME, JSON.stringify({ request: "compare 3 coffee grinders" })), text("Your view is ready.")]);
    await collect(build(model, uiGenerate as never), "compare 3 coffee grinders");
    expect(seen).toEqual(["compare 3 coffee grinders"]);
  });

  it("ignores anything the model attaches and runs against the real turn text", async () => {
    const seen: string[] = [];
    const uiGenerate = vi.fn(async (request: string) => {
      seen.push(request);
      return READY;
    });
    const model = scriptedModel([
      toolCall(UI_GENERATE_TOOL_NAME, JSON.stringify({ request: "make me a dashboard about anything" })),
      text("Your view is ready."),
    ]);
    await collect(build(model, uiGenerate as never), "compare 3 coffee grinders");
    // The bogus argument is discarded; the pipeline gets the turn's own text.
    expect(seen).toEqual(["compare 3 coffee grinders"]);
  });
});

describe("conversation loop", () => {
  it("answers directly without calling the tool", async () => {
    const uiGenerate = vi.fn();
    const model = scriptedModel([text("Paris is the capital of France.")]);
    const events = await collect(build(model, uiGenerate as never), "what is the capital of France?");
    expect(uiGenerate).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.delta).join("")).toBe("Paris is the capital of France.");
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("runs one ui.generate call and streams its progress, view, and terminal status", async () => {
    const uiGenerate = vi.fn(async (_request: string, context: { emitProgress: (state: string) => void; emitView: (view: unknown) => void }) => {
      context.emitProgress("source_finding");
      context.emitProgress("rendering");
      context.emitView({ instanceId: "i1", artifactId: `gui_${"a".repeat(64)}`, planDigest: "b".repeat(64), inputDigest: "c".repeat(64), revision: 0, expiresAt: "2026-09-02T10:00:00.000Z", title: "Grinders", sourceCount: 2, coverage: "validated", fallbackText: "x" });
      return READY;
    });
    const model = scriptedModel([toolCall(UI_GENERATE_TOOL_NAME, JSON.stringify({ request: "compare grinders" })), text("Your comparison view is ready.")]);
    const events = await collect(build(model, uiGenerate as never), "compare grinders");
    expect(events.filter((event) => event.type === "tool-progress").map((event) => event.state)).toEqual(["source_finding", "rendering"]);
    expect(events.some((event) => event.type === "generated-ui")).toBe(true);
    expect(events.find((event) => event.type === "tool-status" && event.state === "completed")).toBeDefined();
  });

  it("streams the generated-ui view while ui.generate is still running, not only after it returns", async () => {
    // The real pipeline's last step blocks on the surface's ready handshake,
    // and the surface is only mounted once the client receives this event.
    // If the orchestrator buffers it until execute() resolves, the turn
    // deadlocks -- so the consumer here withholds completion until it has
    // actually seen the `generated-ui` event.
    let releaseExecution: () => void = () => {};
    const executionMayFinish = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const uiGenerate = vi.fn(async (_request: string, context: { emitView: (view: unknown) => void }) => {
      context.emitView({ instanceId: "i1", artifactId: `gui_${"a".repeat(64)}`, implementationPromptDigest: "b".repeat(64), inputDigest: "c".repeat(64), revision: 0, expiresAt: "2026-09-02T10:00:00.000Z", title: "Grinders", sourceCount: 2, coverage: "validated", fallbackText: "x" });
      await executionMayFinish;
      return READY;
    });
    const model = scriptedModel([toolCall(UI_GENERATE_TOOL_NAME, "{}"), text("Ready.")]);
    const events: OrchestratorEvent[] = [];
    for await (const event of build(model, uiGenerate as never).run({ sessionId: "s1", ownerId: "owner", text: "compare grinders" })) {
      events.push(event);
      if (event.type === "generated-ui") releaseExecution();
    }
    expect(events.some((event) => event.type === "generated-ui")).toBe(true);
    expect(events.find((event) => event.type === "tool-status" && event.state === "completed")).toBeDefined();
  });

  it("reports a failed generation as a failed tool status carrying only the closed category", async () => {
    const uiGenerate = vi.fn(async () => uiGenerateFailure("capture_failed"));
    const model = scriptedModel([toolCall(UI_GENERATE_TOOL_NAME, JSON.stringify({ request: "compare grinders" })), text("Generating the interface failed.")]);
    const events = await collect(build(model, uiGenerate as never), "compare grinders");
    const failed = events.find((event) => event.type === "tool-status" && event.state === "failed");
    expect(failed).toMatchObject({ state: "failed", response: "capture_failed" });
    expect(events.some((event) => event.type === "generated-ui")).toBe(false);
  });

  it("withholds the tool after one call, so a second turn step cannot re-run it", async () => {
    const uiGenerate = vi.fn(async () => READY);
    const model = scriptedModel([toolCall(UI_GENERATE_TOOL_NAME, JSON.stringify({ request: "compare grinders" })), text("Ready.")]);
    await collect(build(model, uiGenerate as never), "compare grinders");
    expect(model.requests[0]!.tools?.map((tool) => tool.name)).toEqual([UI_GENERATE_TOOL_NAME]);
    expect(model.requests[1]!.tools ?? []).toHaveLength(0);
  });

  it("fails closed on a tool the registry does not contain", async () => {
    const model = scriptedModel([toolCall("browser.explore_website", JSON.stringify({ url: "https://example.com" }))]);
    await expect(collect(build(model, vi.fn() as never), "read this")).rejects.toMatchObject({ code: "UNKNOWN_TOOL" });
  });

  it("fails closed on more than one call in a single step", async () => {
    const model = scriptedModel([
      [
        { type: "tool-call-delta", index: 0, id: "c1", name: UI_GENERATE_TOOL_NAME, argumentsDelta: JSON.stringify({ request: "a" }) },
        { type: "tool-call-delta", index: 1, id: "c2", name: UI_GENERATE_TOOL_NAME, argumentsDelta: JSON.stringify({ request: "b" }) },
      ],
    ]);
    await expect(collect(build(model, vi.fn() as never), "compare grinders")).rejects.toMatchObject({ code: "REPEATED_TOOL_CALL" });
  });

  it("fails closed on arguments that do not match the closed schema", async () => {
    const model = scriptedModel([toolCall(UI_GENERATE_TOOL_NAME, JSON.stringify({ request: "a", url: "https://example.com" }))]);
    await expect(collect(build(model, vi.fn() as never), "compare grinders")).rejects.toBeInstanceOf(OrchestratorError);
  });

  it("ends the turn rather than spending its budget on empty responses", async () => {
    const model = scriptedModel([[], [], []]);
    await expect(collect(build(model, vi.fn() as never), "hello")).rejects.toMatchObject({ code: "EMPTY_RESPONSE" });
  });

  it("appends only the closed result to model context", async () => {
    const uiGenerate = vi.fn(async () => READY);
    const model = scriptedModel([toolCall(UI_GENERATE_TOOL_NAME, JSON.stringify({ request: "compare grinders" })), text("Ready.")]);
    await collect(build(model, uiGenerate as never), "compare grinders");
    const toolTurn = model.requests[1]!.turns.find((turn) => turn.role === "tool");
    expect(JSON.parse(toolTurn!.content)).toEqual(READY);
  });
});
