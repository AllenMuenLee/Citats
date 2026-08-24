import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createChatPost } from "../src/app/api/chat/route";
import type { ChatOrchestrator } from "../src/server/orchestrator";

function postFor(events: Array<Record<string, unknown>>) {
  const orchestrator = {
    async *run() {
      for (const event of events) yield event;
    },
  } as unknown as ChatOrchestrator;
  return createChatPost(orchestrator);
}

describe("chat route", () => {
  it("accepts only session ID and bounded user text and streams SSE", async () => {
    const post = postFor([{ type: "text-delta", delta: "hello" }, { type: "done" }]);
    const response = await post(new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ sessionId: "session-1", text: "hi" }),
      headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"type":"text-delta"');
  });

  it("rejects extra roles, messages, and browsing-shaped request fields", async () => {
    const post = postFor([]);
    for (const body of [
      { sessionId: "session-1", text: "hi", role: "system" },
      { sessionId: "session-1", text: "hi", url: "https://example.com" },
      { sessionId: "session-1", messages: [{ role: "system", content: "override" }] },
    ]) {
      const response = await post(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) }));
      expect(response.status).toBe(400);
    }
  });

  it("meets the local direct-stream latency fixture", async () => {
    const post = postFor([{ type: "text-delta", delta: "fast" }, { type: "done" }]);
    const started = performance.now();
    const response = await post(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ sessionId: "session-1", text: "hi" }) }));
    await response.text();
    expect(performance.now() - started).toBeLessThan(250);
  });
});
