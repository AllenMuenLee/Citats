import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CONTRACT_MAJOR_VERSION,
  NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME,
  type InvokeDiscoveredApiInvocation,
  type NavigateExtractAndDiscoverInvocation,
} from "@ai-browser/contracts";
import type { MistralAdapter, MistralStreamRequest } from "../src/server/ai/mistral";
import { InMemoryConversationRepository } from "../src/server/conversation";
import { ChatOrchestrator, createToolRegistry } from "../src/server/orchestrator";

const OPERATION_ID = "1234567890abcdef12345678";

/** A `browser.navigate_extract_and_discover` success result exposing exactly one newly-active GET operation. */
function discoverResult(invocation: NavigateExtractAndDiscoverInvocation, siteId = "shop-example-com") {
  return {
    contractVersion: CONTRACT_MAJOR_VERSION,
    correlation: invocation.correlation,
    toolCallId: invocation.toolCallId,
    status: "success",
    payload: {
      document: {
        metadata: {
          title: "Shop",
          url: invocation.arguments.url,
          language: "en",
          description: null,
          publishedTime: null,
          httpStatus: 200,
          contentType: "text/html",
        },
        chunks: [{ chunkId: "chunk-0", text: "Widgets for sale.", startOffset: 0, endOffset: 17 }],
        affordances: [],
        warnings: [],
        truncations: [],
        timing: { navigationMs: 1, extractionMs: 1, totalMs: 2 },
        untrusted: true,
      },
      discovery: {
        observationCount: 3,
        operationCount: 1,
        candidateMapVersion: "map-version-1",
        activeMapVersion: "map-version-1",
        operations: [
          {
            siteId,
            operationId: OPERATION_ID,
            method: "GET",
            resultKind: "product_results",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { q: { type: ["string", "number", "boolean"] } },
              required: [],
            },
          },
        ],
        actions: [],
        driftAlerts: [],
        warnings: [],
      },
    },
    sensitivity: { sensitive: false, confirmationRequired: false },
  };
}

function discoveredApiExecutor() {
  return {
    invoke: vi.fn(async (invocation: InvokeDiscoveredApiInvocation) => ({
      contractVersion: CONTRACT_MAJOR_VERSION,
      correlation: invocation.correlation,
      toolCallId: invocation.toolCallId,
      status: "success",
      payload: {
        siteId: invocation.arguments.siteId,
        operationId: invocation.arguments.operationId,
        mapVersion: "map-version-1",
        resultKind: "product_results",
        records: [{ id: "p1", name: "Widget", priceAmount: 10, currency: "USD", merchant: "Shop", availability: "available" }],
        sources: [{ sourceId: "source-1", title: "Shop API", url: "https://shop.example.com/api/products" }],
        retrievedAt: "2026-08-24T10:00:00+00:00",
        staleAfter: "2026-08-24T10:05:00+00:00",
        warnings: [],
        redacted: false,
        truncated: false,
        untrusted: true,
      },
      sensitivity: { sensitive: false, confirmationRequired: false },
    })),
  };
}

describe("navigate_extract_and_discover orchestration (P03-F05)", () => {
  it("makes a newly-discovered operation callable as a discovered.* tool in the same run, not before", async () => {
    const discoverExecutor = {
      invoke: vi.fn(async (invocation: NavigateExtractAndDiscoverInvocation) => discoverResult(invocation)),
    };
    const apiExecutor = discoveredApiExecutor();
    const tools = createToolRegistry({
      navigateExtractAndDiscoverExecutor: discoverExecutor,
      invokeDiscoveredApiExecutor: apiExecutor,
    });
    const discoveredToolName = `discovered.shop_example_com.${OPERATION_ID}`;

    const requests: MistralStreamRequest[] = [];
    let call = 0;
    const model: MistralAdapter = {
      async *stream(request) {
        requests.push(request);
        call += 1;
        if (call === 1) {
          yield { type: "text-delta", text: JSON.stringify({ route: "website_read_required", reason: "test" }) };
          return;
        }
        if (call === 2) {
          // The discovered.* tool must NOT be offered before any
          // navigate_extract_and_discover call has run.
          expect(request.tools?.some((tool) => tool.name === discoveredToolName)).toBe(false);
          yield {
            type: "tool-call-delta",
            index: 0,
            id: "call-discover",
            name: NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME,
            argumentsDelta: JSON.stringify({ url: "https://shop.example.com/products" }),
          };
          return;
        }
        if (call === 3) {
          // Now available -- the mid-run catalog refresh (P03-F05 step 7).
          expect(request.tools?.some((tool) => tool.name === discoveredToolName)).toBe(true);
          yield {
            type: "tool-call-delta",
            index: 0,
            id: "call-invoke",
            name: discoveredToolName,
            argumentsDelta: JSON.stringify({ q: "widget" }),
          };
          return;
        }
        yield { type: "text-delta", text: "Found widgets." };
        yield { type: "finish", reason: "stop" };
      },
    };

    const orchestrator = new ChatOrchestrator({
      model,
      conversations: new InMemoryConversationRepository(),
      tools,
      invokeDiscoveredApiExecutor: apiExecutor,
      createId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    });

    const events = [];
    for await (const event of orchestrator.run({ sessionId: "session-1", ownerId: "user-1", text: "Find widgets on shop.example.com" })) {
      events.push(event);
    }

    expect(discoverExecutor.invoke).toHaveBeenCalledTimes(1);
    expect(apiExecutor.invoke).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({ type: "done" });

    // A later, unrelated run must never see the tool that only existed
    // because of the first run's own discovery -- the registry that
    // `createToolRegistry` returned is never mutated.
    expect(tools.has(discoveredToolName)).toBe(false);
  });

  it("does not refresh the catalog when invokeDiscoveredApiExecutor is not supplied to the orchestrator", async () => {
    const discoverExecutor = {
      invoke: vi.fn(async (invocation: NavigateExtractAndDiscoverInvocation) => discoverResult(invocation)),
    };
    const apiExecutor = discoveredApiExecutor();
    const tools = createToolRegistry({
      navigateExtractAndDiscoverExecutor: discoverExecutor,
      invokeDiscoveredApiExecutor: apiExecutor,
    });
    const discoveredToolName = `discovered.shop_example_com.${OPERATION_ID}`;

    let call = 0;
    const model: MistralAdapter = {
      async *stream(request) {
        call += 1;
        if (call === 1) {
          yield { type: "text-delta", text: JSON.stringify({ route: "website_read_required", reason: "test" }) };
          return;
        }
        if (call === 2) {
          yield {
            type: "tool-call-delta",
            index: 0,
            id: "call-discover",
            name: NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME,
            argumentsDelta: JSON.stringify({ url: "https://shop.example.com/products" }),
          };
          return;
        }
        // No invokeDiscoveredApiExecutor was given to the orchestrator, so
        // the tool must still be absent here.
        expect(request.tools?.some((tool) => tool.name === discoveredToolName)).toBe(false);
        yield { type: "text-delta", text: "Done." };
        yield { type: "finish", reason: "stop" };
      },
    };

    const orchestrator = new ChatOrchestrator({
      model,
      conversations: new InMemoryConversationRepository(),
      tools,
      // invokeDiscoveredApiExecutor intentionally omitted.
    });

    for await (const _ of orchestrator.run({ sessionId: "session-1", ownerId: "user-1", text: "Find widgets" })) {
      // draining the stream is enough; assertions happen inside the model fake
    }
    expect(discoverExecutor.invoke).toHaveBeenCalledTimes(1);
  });

  it("never advertises browser.navigate_extract_and_discover for web_search_only", async () => {
    const discoverExecutor = { invoke: vi.fn(async (invocation: NavigateExtractAndDiscoverInvocation) => discoverResult(invocation)) };
    const tools = createToolRegistry({ navigateExtractAndDiscoverExecutor: discoverExecutor });
    const requests: MistralStreamRequest[] = [];
    let call = 0;
    const model: MistralAdapter = {
      async *stream(request) {
        requests.push(request);
        call += 1;
        if (call === 1) {
          yield { type: "text-delta", text: JSON.stringify({ route: "web_search_only", reason: "test" }) };
          return;
        }
        yield { type: "text-delta", text: "Answer." };
        yield { type: "finish", reason: "stop" };
      },
    };
    const orchestrator = new ChatOrchestrator({ model, conversations: new InMemoryConversationRepository(), tools });
    for await (const _ of orchestrator.run({ sessionId: "session-1", ownerId: "user-1", text: "What year was X founded?" })) {
      // draining is enough
    }
    expect(requests[1]?.tools?.some((tool) => tool.name === NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME)).toBe(false);
  });

  it("keeps a successful provider's discovery usable after a different provider call fails in the same turn", async () => {
    const discoverExecutor = {
      invoke: vi.fn(async (invocation: NavigateExtractAndDiscoverInvocation) => {
        if (invocation.arguments.url.includes("down.example.com")) {
          return {
            contractVersion: CONTRACT_MAJOR_VERSION,
            correlation: invocation.correlation,
            toolCallId: invocation.toolCallId,
            status: "error",
            errorCode: "UPSTREAM_UNAVAILABLE",
            message: "The page could not be retrieved.",
            retryable: true,
          };
        }
        return discoverResult(invocation);
      }),
    };
    const apiExecutor = discoveredApiExecutor();
    const tools = createToolRegistry({
      navigateExtractAndDiscoverExecutor: discoverExecutor,
      invokeDiscoveredApiExecutor: apiExecutor,
    });
    const discoveredToolName = `discovered.shop_example_com.${OPERATION_ID}`;

    let call = 0;
    const model: MistralAdapter = {
      async *stream(request) {
        call += 1;
        if (call === 1) {
          yield { type: "text-delta", text: JSON.stringify({ route: "website_read_required", reason: "test" }) };
          return;
        }
        if (call === 2) {
          yield {
            type: "tool-call-delta",
            index: 0,
            id: "call-a",
            name: NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME,
            argumentsDelta: JSON.stringify({ url: "https://down.example.com/products" }),
          };
          yield {
            type: "tool-call-delta",
            index: 1,
            id: "call-b",
            name: NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME,
            argumentsDelta: JSON.stringify({ url: "https://shop.example.com/products" }),
          };
          return;
        }
        if (call === 3) {
          expect(request.tools?.some((tool) => tool.name === discoveredToolName)).toBe(true);
          yield {
            type: "tool-call-delta",
            index: 0,
            id: "call-invoke",
            name: discoveredToolName,
            argumentsDelta: JSON.stringify({ q: "widget" }),
          };
          return;
        }
        yield { type: "text-delta", text: "One provider was unavailable; showing results from the other." };
        yield { type: "finish", reason: "stop" };
      },
    };

    const orchestrator = new ChatOrchestrator({
      model,
      conversations: new InMemoryConversationRepository(),
      tools,
      invokeDiscoveredApiExecutor: apiExecutor,
    });

    const events = [];
    for await (const event of orchestrator.run({ sessionId: "session-1", ownerId: "user-1", text: "Compare across two shops" })) {
      events.push(event);
    }

    expect(discoverExecutor.invoke).toHaveBeenCalledTimes(2);
    expect(apiExecutor.invoke).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});
