import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { EXPLORE_WEBSITE_TOOL_NAME, type ExploreWebsiteSuccessResult } from "@ai-browser/contracts";
import type { ModelAdapter, ModelStreamRequest } from "../src/server/ai";
import { InMemoryConversationRepository } from "../src/server/conversation";
import { ChatOrchestrator, createToolRegistry, type OrchestratorEvent } from "../src/server/orchestrator";
import { buildExploreResult } from "./helpers/explore-result";

const digest = {
  overview: "Twenty harbour-district lofts in Seattle with nightly prices and ratings.",
  collections: [{ collectionHandle: "col-search-results", summary: "Twenty lofts.", highlights: ["Loft at 180 per night, rated 4.0"] }],
  keyFacts: [{ fact: "Listings start at 180 per night.", chunkId: "chunk-0" }],
  gaps: [],
};

function scriptedModel(requests: ModelStreamRequest[]): ModelAdapter {
  let call = 0;
  return {
    async *stream(request) {
      requests.push(request);
      call += 1;
      if (call === 1) {
        yield { type: "text-delta", text: JSON.stringify({ route: "website_read_required", reason: "named site" }) };
        return;
      }
      if (call === 2) {
        yield { type: "tool-call-delta", index: 0, id: "call-1", name: EXPLORE_WEBSITE_TOOL_NAME, argumentsDelta: JSON.stringify({ url: "https://example.com/s/seattle" }) };
        return;
      }
      yield { type: "text-delta", text: "Here are the stays." };
      yield { type: "finish", reason: "stop" };
    },
  };
}

async function runTurn(options: { compress: boolean }): Promise<{
  requests: ModelStreamRequest[];
  compressCalls: Array<{ result: ExploreWebsiteSuccessResult }>;
  events: OrchestratorEvent[];
  conversations: InMemoryConversationRepository;
}> {
  const requests: ModelStreamRequest[] = [];
  const compressCalls: Array<{ result: ExploreWebsiteSuccessResult }> = [];
  const conversations = new InMemoryConversationRepository();
  const orchestrator = new ChatOrchestrator({
    model: scriptedModel(requests),
    conversations,
    tools: createToolRegistry({ phaseThreeExecutor: { invoke: async () => buildExploreResult() } }),
    ...(options.compress
      ? {
          compressObservation: async (input) => {
            compressCalls.push({ result: input.result });
            return digest;
          },
        }
      : {}),
  });
  const events: OrchestratorEvent[] = [];
  for await (const event of orchestrator.run({ sessionId: "s1", ownerId: "u1", text: "compare stays in seattle" })) events.push(event);
  return { requests, compressCalls, events, conversations };
}

/** The tool turn the conversation model is handed after the observation lands. */
function toolTurn(requests: ModelStreamRequest[]): string {
  const last = requests.at(-1);
  const turn = last?.turns.find((candidate) => candidate.role === "tool");
  return turn?.content ?? "";
}

describe("ChatOrchestrator with EXTRACTION_MODEL configured", () => {
  it("reads the high-context observation once, not once per step", async () => {
    const { compressCalls, requests } = await runTurn({ compress: true });
    expect(compressCalls).toHaveLength(1);
    // The info model gets the whole result; the conversation model never does.
    expect(compressCalls[0]?.result.payload.pageUnderstanding.nodes).toHaveLength(280);
    expect(requests.length).toBeGreaterThan(2);
  });

  it("hands the conversation model the digest instead of the graph", async () => {
    const { requests } = await runTurn({ compress: true });
    const content = toolTurn(requests);
    expect(content).toContain("Twenty harbour-district lofts");
    expect(content).toContain("Listings start at 180 per night");
    expect(content).not.toContain("boundingBox");
    // Only the relationship *count* survives, never the edge list itself.
    expect(content).not.toContain("record_field");
    expect(content).not.toContain("repeated_record");
  });

  it("costs the conversation model less than the projection alone does", async () => {
    const withDigest = toolTurn((await runTurn({ compress: true })).requests);
    const withoutDigest = toolTurn((await runTurn({ compress: false })).requests);
    expect(withoutDigest.length).toBeGreaterThan(0);
    expect(withDigest.length).toBeLessThan(withoutDigest.length);
  });

  it("persists the digested turn, so later turns re-send the digest and not the graph", async () => {
    const { conversations } = await runTurn({ compress: true });
    const stored = conversations.read("s1", "u1")
      .flatMap((turn) => turn.messages)
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool-result" && part.toolName === EXPLORE_WEBSITE_TOOL_NAME);
    expect(JSON.stringify(stored)).toContain("Twenty harbour-district lofts");
    expect(JSON.stringify(stored)).not.toContain("boundingBox");
  });

  it("still completes the turn when compression fails", async () => {
    const conversations = new InMemoryConversationRepository();
    const requests: ModelStreamRequest[] = [];
    const orchestrator = new ChatOrchestrator({
      model: scriptedModel(requests),
      conversations,
      tools: createToolRegistry({ phaseThreeExecutor: { invoke: async () => buildExploreResult() } }),
      compressObservation: async () => {
        throw new Error("info model unavailable");
      },
    });
    const events: OrchestratorEvent[] = [];
    for await (const event of orchestrator.run({ sessionId: "s1", ownerId: "u1", text: "compare stays in seattle" })) events.push(event);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(toolTurn(requests)).toContain("observationId");
  });
});
