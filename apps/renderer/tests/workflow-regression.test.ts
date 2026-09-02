import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { UI_GENERATE_TOOL_NAME, uiGenerateFailure, type UiGenerateResult } from "@ai-browser/contracts";
import type { ModelAdapter, ModelStreamEvent, ModelStreamRequest } from "../src/server/ai";
import { InMemoryConversationRepository } from "../src/server/conversation";
import { ChatOrchestrator, createToolRegistry, type OrchestratorEvent } from "../src/server/orchestrator";

const READY: UiGenerateResult = {
  status: "ready",
  viewRef: "uiv_abcdefgh",
  title: "Seattle stays",
  sourceCount: 6,
  coverage: "validated",
};

function scriptedModel(steps: readonly ModelStreamEvent[][]): ModelAdapter & { requests: ModelStreamRequest[] } {
  const requests: ModelStreamRequest[] = [];
  let step = 0;
  return {
    requests,
    async *stream(request) {
      requests.push(request);
      for (const event of steps[step] ?? []) yield event;
      step += 1;
    },
  };
}

function call(request: string): ModelStreamEvent[] {
  return [{
    type: "tool-call-delta",
    index: 0,
    id: "call-ui",
    name: UI_GENERATE_TOOL_NAME,
    argumentsDelta: JSON.stringify({ request }),
  }];
}

function answer(value: string): ModelStreamEvent[] {
  return [{ type: "text-delta", text: value }];
}

function harness(model: ModelAdapter, uiGenerate: Parameters<typeof createToolRegistry>[0]["uiGenerate"]) {
  return new ChatOrchestrator({
    model,
    conversations: new InMemoryConversationRepository(),
    tools: createToolRegistry({ uiGenerate }),
  });
}

async function collect(orchestrator: ChatOrchestrator, prompt: string): Promise<OrchestratorEvent[]> {
  const events: OrchestratorEvent[] = [];
  for await (const event of orchestrator.run({ sessionId: "session-1", ownerId: "user-1", text: prompt })) {
    events.push(event);
  }
  return events;
}

describe("single generative UI tool golden regressions", () => {
  it("leaves an ambiguous request to the model and accepts its direct answer", async () => {
    const generate = vi.fn();
    const model = scriptedModel([answer("I can help narrow that down. What matters most to you?")]);
    const events = await collect(harness(model, generate as never), "help me find somewhere to stay");
    expect(generate).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools?.map((tool) => tool.name)).toEqual([UI_GENERATE_TOOL_NAME]);
    expect(events.some((event) => event.type === "generated-ui")).toBe(false);
  });

  it("creates a view only after the model calls ui.generate with the exact request", async () => {
    const prompt = "give me 6 Seattle stays and generate a UI to compare them";
    const generate = vi.fn(async () => READY);
    const model = scriptedModel([call(prompt), answer("Your comparison is ready.")]);
    const events = await collect(harness(model, generate as never), prompt);
    expect(generate).toHaveBeenCalledOnce();
    expect(model.requests[1]!.tools ?? []).toEqual([]);
    expect(JSON.parse(model.requests[1]!.turns.at(-1)!.content)).toEqual(READY);
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.delta).join(""))
      .toBe("Your comparison is ready.");
  });

  it("gives the model a closed failure result and never emits a generated view", async () => {
    const prompt = "show a visual comparison of Seattle stays";
    const failed = uiGenerateFailure("capture_failed");
    const model = scriptedModel([call(prompt), answer("Generating the interface failed, but I can still help in text.")]);
    const events = await collect(harness(model, async () => failed), prompt);
    expect(JSON.parse(model.requests[1]!.turns.at(-1)!.content)).toEqual(failed);
    expect(events.some((event) => event.type === "generated-ui")).toBe(false);
    expect(events.some((event) => event.type === "tool-status" && event.state === "failed")).toBe(true);
  });
});
