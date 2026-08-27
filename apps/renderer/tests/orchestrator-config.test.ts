import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readOrchestratorConfig } from "../src/server/orchestrator/config";

describe("readOrchestratorConfig", () => {
  it("defaults to a generous runaway-loop step cap, with no time-based deadline", () => {
    expect(readOrchestratorConfig({})).toEqual({ maxSteps: 25, maxContextTokens: 16_000, logTokenUsage: false });
  });

  it("leaves the in-turn token ceiling unset so nothing a turn gathered is elided by default", () => {
    expect(readOrchestratorConfig({}).maxRunTokens).toBeUndefined();
  });

  it("reads a maxSteps override from the environment", () => {
    expect(readOrchestratorConfig({ CHAT_MAX_STEPS: "15" })).toMatchObject({ maxSteps: 15 });
  });

  it("reads the context and run token budgets from the environment", () => {
    expect(readOrchestratorConfig({ CHAT_MAX_CONTEXT_TOKENS: "3000", CHAT_MAX_RUN_TOKENS: "8000", CHAT_LOG_TOKEN_USAGE: "1" }))
      .toEqual({ maxSteps: 25, maxContextTokens: 3_000, maxRunTokens: 8_000, logTokenUsage: true });
  });

  it("rejects an out-of-range override instead of silently clamping it", () => {
    expect(() => readOrchestratorConfig({ CHAT_MAX_STEPS: "0" })).toThrow(/Orchestrator configuration is invalid/);
    expect(() => readOrchestratorConfig({ CHAT_MAX_RUN_TOKENS: "10" })).toThrow(/Orchestrator configuration is invalid/);
  });
});
