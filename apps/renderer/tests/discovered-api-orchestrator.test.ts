import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CONTRACT_MAJOR_VERSION,
  type InvokeDiscoveredApiInvocation,
} from "@ai-browser/contracts";
import type { MistralAdapter } from "../src/server/ai/mistral";
import { InMemoryConversationRepository } from "../src/server/conversation";
import { ChatOrchestrator, createToolRegistry } from "../src/server/orchestrator";

describe("discovered API orchestration", () => {
  it("streams a validated product component from a read-only API result", async () => {
    let call = 0;
    const model: MistralAdapter = {
      async *stream() {
        call += 1;
        if (call === 1) {
          yield { type: "text-delta", text: JSON.stringify({ route: "website_read_required", reason: "fixture comparison" }) };
        } else if (call === 2) {
          yield {
            type: "tool-call-delta",
            index: 0,
            id: "call-1",
            name: "discovered.local_fixture.1234567890abcdef12345678",
            argumentsDelta: JSON.stringify({ q: "headphones" }),
          };
        } else {
          yield { type: "text-delta", text: "Comparison ready." };
        }
      },
    };
    const executor = {
      invoke: vi.fn(async (invocation: InvokeDiscoveredApiInvocation) => ({
        contractVersion: CONTRACT_MAJOR_VERSION,
        correlation: invocation.correlation,
        toolCallId: invocation.toolCallId,
        status: "success",
        payload: {
          siteId: "local-fixture",
          operationId: invocation.arguments.operationId,
          mapVersion: "map-version-1",
          resultKind: "product_results",
          records: [{ id: "p1", name: "Fixture headphones", priceAmount: 99, currency: "USD", merchant: "Fixture shop", availability: "available" }],
          sources: [{ sourceId: "source-1", title: "Fixture API", url: "http://localhost:8765/api/products" }],
          retrievedAt: "2026-08-24T10:00:00+08:00",
          staleAfter: "2026-08-24T10:05:00+08:00",
          warnings: [],
          redacted: false,
          truncated: false,
          untrusted: true,
        },
        sensitivity: { sensitive: false, confirmationRequired: false },
      })),
    };
    const orchestrator = new ChatOrchestrator({
      model,
      conversations: new InMemoryConversationRepository(),
      tools: createToolRegistry({
        invokeDiscoveredApiExecutor: executor,
        discoveredApiDefinitions: [{
          siteId: "local-fixture",
          operationId: "1234567890abcdef12345678",
          method: "GET",
          resultKind: "product_results",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { q: { type: ["string", "number", "boolean"] } },
            required: [],
          },
        }],
      }),
      createId: (() => { let id = 0; return () => `request-${++id}`; })(),
    });
    const events = [];
    for await (const event of orchestrator.run({ sessionId: "session-1", ownerId: "user-1", text: "Compare headphones" })) events.push(event);
    const generated = events.find((event) => event.type === "generative-ui");
    expect(generated).toMatchObject({ type: "generative-ui", payload: { component_type: "product_results", props: { items: [{ id: "p1" }] } } });
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});
