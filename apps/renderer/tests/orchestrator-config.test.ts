import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readOrchestratorConfig } from "../src/server/orchestrator/config";

describe("readOrchestratorConfig", () => {
  it("defaults to a small runaway-loop step cap, with no time-based deadline", () => {
    // A turn is at most one ui.generate call plus the answer that reports it.
    expect(readOrchestratorConfig({})).toEqual({ maxSteps: 3, maxContextTokens: 16_000, logTokenUsage: false });
  });

  it("reads a maxSteps override from the environment", () => {
    expect(readOrchestratorConfig({ CHAT_MAX_STEPS: "15" })).toMatchObject({ maxSteps: 15 });
  });

  it("reads the context budget and usage logging from the environment", () => {
    expect(readOrchestratorConfig({ CHAT_MAX_CONTEXT_TOKENS: "3000", CHAT_LOG_TOKEN_USAGE: "1" }))
      .toEqual({ maxSteps: 3, maxContextTokens: 3_000, logTokenUsage: true });
  });

  it("rejects an out-of-range override instead of silently clamping it", () => {
    expect(() => readOrchestratorConfig({ CHAT_MAX_STEPS: "0" })).toThrow(/Orchestrator configuration is invalid/);
    expect(() => readOrchestratorConfig({ CHAT_MAX_CONTEXT_TOKENS: "10" })).toThrow(/Orchestrator configuration is invalid/);
  });
});
