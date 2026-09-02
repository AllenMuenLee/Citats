import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createTranscriptLogger,
  readTranscriptLogConfig,
  withTranscriptLog,
  type ModelAdapter,
  type ModelStreamEvent,
  type TranscriptEntry,
} from "../src/server/ai";

function adapterFrom(events: ModelStreamEvent[]): ModelAdapter {
  return {
    provider: "gemini",
    async *stream() {
      for (const event of events) yield event;
    },
  };
}

const request = {
  correlationId: "correlation-1",
  systemInstruction: "Trusted policy",
  turns: [
    { role: "user" as const, content: "find me listings" },
    { role: "assistant" as const, content: "", toolCalls: [{ id: "call-1", name: "browser.explore_website", arguments: "{\"url\":\"https://example.com/\"}" }] },
    { role: "tool" as const, content: "{\"status\":\"success\"}", toolCallId: "call-1", name: "browser.explore_website" },
  ],
  tools: [{ name: "browser.explore_website", description: "d", strict: true as const, parameters: {} }],
  hostedTools: ["web_search" as const],
};

function recordingLogger(): { entries: TranscriptEntry[]; logger: Parameters<typeof withTranscriptLog>[2] } {
  const entries: TranscriptEntry[] = [];
  return { entries, logger: { enabled: true, file: "memory", record: (entry) => entries.push(entry) } };
}

describe("conversation transcript", () => {
  it("is disabled unless CHAT_LOG_CONVERSATION is set, and never writes when disabled", () => {
    expect(readTranscriptLogConfig({}).enabled).toBe(false);
    expect(readTranscriptLogConfig({ CHAT_LOG_CONVERSATION: "1" })).toMatchObject({ enabled: true, directory: ".ai-logs" });
    const disabled = createTranscriptLogger({ enabled: false, directory: ".ai-logs", console: false, maxFieldChars: 100 });
    expect(disabled.enabled).toBe(false);
    expect(disabled.file).toBeUndefined();
  });

  it("records what the model was shown and what it replied, including the tool surface", async () => {
    const { entries, logger } = recordingLogger();
    const wrapped = withTranscriptLog(adapterFrom([
      { type: "text-delta", text: "Looking" },
      { type: "tool-call-delta", index: 0, id: "call-2", name: "browser.explore_website", argumentsDelta: "{\"url\":" },
      { type: "tool-call-delta", index: 0, argumentsDelta: "\"https://example.com/\"}" },
      { type: "finish", reason: "stop" },
      { type: "usage", promptTokens: 10, completionTokens: 3, totalTokens: 13 },
    ]), "chat", logger);

    const seen: ModelStreamEvent[] = [];
    for await (const event of wrapped.stream(request)) seen.push(event);

    // Transparent: the caller sees exactly the adapter's own events.
    expect(seen).toHaveLength(5);
    expect(entries[0]).toMatchObject({
      kind: "model-request",
      role: "chat",
      tools: ["browser.explore_website"],
      hostedTools: ["web_search"],
    });
    expect((entries[0] as Extract<TranscriptEntry, { kind: "model-request" }>).turns).toHaveLength(3);
    expect(entries[1]).toMatchObject({
      kind: "model-response",
      text: "Looking",
      toolCalls: [{ index: 0, id: "call-2", name: "browser.explore_website", arguments: "{\"url\":\"https://example.com/\"}" }],
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
    });
  });

  it("records a failed call and rethrows it unchanged", async () => {
    const { entries, logger } = recordingLogger();
    const failure = new Error("provider exploded");
    const wrapped = withTranscriptLog({
      provider: "gemini",
      async *stream() { throw failure; },
    }, "chat", logger);

    await expect((async () => { for await (const _ of wrapped.stream(request)) void _; })()).rejects.toBe(failure);
    expect(entries[1]).toMatchObject({ kind: "model-error", role: "chat", error: "Error: provider exploded" });
  });

  it("writes one JSONL line per entry and truncates an oversized field", () => {
    const directory = mkdtempSync(join(tmpdir(), "transcript-"));
    const logger = createTranscriptLogger({ enabled: true, directory, console: false, maxFieldChars: 10 });
    logger.record({
      kind: "model-request",
      role: "chat",
      correlationId: "c-1",
      systemInstruction: "0123456789ABCDEF",
      turns: [{ role: "user", content: "short" }],
      tools: [],
      hostedTools: [],
    });

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(directory, files[0]!), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { systemInstruction: string; at: string };
    expect(parsed.systemInstruction).toBe("0123456789...[truncated 6 chars]");
    expect(Date.parse(parsed.at)).not.toBeNaN();
  });
});
