import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  EXPLORE_WEBSITE_TOOL_NAME,
  GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME,
  NAVIGATE_AND_EXTRACT_TOOL_NAME,
  SYSTEM_ECHO_TOOL_NAME,
  ERROR_MESSAGE_MAX_LENGTH,
} from "@ai-browser/contracts";
import { BrowserServiceClient } from "../src/server/browser-service/client";
import {
  BrowserServiceContractError,
  BrowserServiceTimeoutError,
  BrowserServiceUnavailableError,
} from "../src/server/browser-service/errors";
import {
  TOOL_TIMEOUT_BOUNDS,
  policedToolNames,
  resolveToolTimeoutMs,
  toolTimeoutPolicy,
} from "../src/server/browser-service/timeouts";
import {
  classifyToolExecutionError,
  classifyToolExecutionErrorOrInternal,
} from "../src/server/browser-service/tool-errors";
import { z } from "zod";

/**
 * The budget the Python browser service owns for one `explore_website`
 * invocation, mirrored here so the two layers' ordering is asserted rather
 * than assumed. Kept in step with
 * `services/browser/src/browser_service/tools/explore_website.py`'s
 * `EXPLORATION_BUDGET.total_seconds`.
 */
const PYTHON_EXPLORE_TOTAL_MS = 45_000;

describe("per-tool browser-service deadlines (P03-R01 steps 1-2)", () => {
  it("no longer puts every tool on one five-second bridge clock", () => {
    // Acceptance item 1: the exact defect that produced the reported
    // `INTERNAL` on a healthy Airbnb exploration.
    expect(resolveToolTimeoutMs(EXPLORE_WEBSITE_TOOL_NAME)).toBeGreaterThan(5_000);
    expect(resolveToolTimeoutMs(NAVIGATE_AND_EXTRACT_TOOL_NAME)).toBeGreaterThan(5_000);
  });

  it("scales the budget to the work each tool actually does", () => {
    expect(resolveToolTimeoutMs(EXPLORE_WEBSITE_TOOL_NAME))
      .toBeGreaterThan(resolveToolTimeoutMs(NAVIGATE_AND_EXTRACT_TOOL_NAME));
    expect(resolveToolTimeoutMs(NAVIGATE_AND_EXTRACT_TOOL_NAME))
      .toBeGreaterThan(resolveToolTimeoutMs(GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME));
    expect(resolveToolTimeoutMs(GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME))
      .toBeGreaterThan(resolveToolTimeoutMs(SYSTEM_ECHO_TOOL_NAME));
  });

  it("keeps the outer renderer deadline strictly outside every inner budget", () => {
    for (const toolName of policedToolNames()) {
      const policy = toolTimeoutPolicy(toolName);
      expect(resolveToolTimeoutMs(toolName)).toBeGreaterThan(policy.innerBudgetMs);
      expect(resolveToolTimeoutMs(toolName) - policy.innerBudgetMs)
        .toBeGreaterThanOrEqual(TOOL_TIMEOUT_BOUNDS.minTransportOverheadMs);
    }
  });

  it("outlasts the browser service's own exploration budget", () => {
    // The layer that does not own the work must never be the layer that
    // gives up first, or the typed cause is replaced by a bridge abort.
    expect(toolTimeoutPolicy(EXPLORE_WEBSITE_TOOL_NAME).innerBudgetMs).toBe(PYTHON_EXPLORE_TOTAL_MS);
    expect(resolveToolTimeoutMs(EXPLORE_WEBSITE_TOOL_NAME)).toBeGreaterThan(PYTHON_EXPLORE_TOTAL_MS);
  });

  it("keeps every configured budget inside its validated bounds", () => {
    for (const toolName of policedToolNames()) {
      const policy = toolTimeoutPolicy(toolName);
      expect(policy.innerBudgetMs).toBeGreaterThanOrEqual(TOOL_TIMEOUT_BOUNDS.minInnerBudgetMs);
      expect(policy.innerBudgetMs).toBeLessThanOrEqual(TOOL_TIMEOUT_BOUNDS.maxInnerBudgetMs);
      expect(policy.transportOverheadMs).toBeGreaterThanOrEqual(TOOL_TIMEOUT_BOUNDS.minTransportOverheadMs);
      expect(policy.transportOverheadMs).toBeLessThanOrEqual(TOOL_TIMEOUT_BOUNDS.maxTransportOverheadMs);
    }
  });

  it("gives an unknown tool the tightest policy, not the most generous", () => {
    expect(resolveToolTimeoutMs("some.unregistered_tool"))
      .toBe(resolveToolTimeoutMs(SYSTEM_ECHO_TOOL_NAME));
    expect(resolveToolTimeoutMs("some.unregistered_tool"))
      .toBeLessThan(resolveToolTimeoutMs(EXPLORE_WEBSITE_TOOL_NAME));
  });

  it("selects the deadline from the tool name on each invocation", async () => {
    const resolveTimeoutMs = vi.fn(() => 30_000);
    const fetchImpl = vi.fn(async () => Response.json({
      contractVersion: 1,
      correlation: { requestId: "req-1", userId: "user-1" },
      toolCallId: "call-1",
      status: "success",
      payload: { message: "hello" },
      sensitivity: { sensitive: false, confirmationRequired: false },
    }));
    const client = new BrowserServiceClient({ baseUrl: "http://127.0.0.1:8123", serviceToken: "s", resolveTimeoutMs, fetchImpl });
    await client.invoke({
      contractVersion: 1 as const,
      correlation: { requestId: "req-1", userId: "user-1" },
      toolCallId: "call-1",
      toolName: SYSTEM_ECHO_TOOL_NAME,
      arguments: { message: "hello" },
    });
    expect(resolveTimeoutMs).toHaveBeenCalledWith(SYSTEM_ECHO_TOOL_NAME);
  });
});

describe("browser-service bridge logging (P03-R01 step 5)", () => {
  it("records phase, tool, correlation, elapsed, and deadline without the service token", async () => {
    const records: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async () => Response.json({
      contractVersion: 1,
      correlation: { requestId: "req-9", userId: "user-1" },
      toolCallId: "call-9",
      status: "error",
      errorCode: "TIMEOUT",
      message: "Website exploration timed out.",
      retryable: true,
    }));
    const client = new BrowserServiceClient({
      baseUrl: "http://127.0.0.1:8123",
      serviceToken: "launch-secret",
      fetchImpl,
      log: (record) => records.push(record),
    });
    await client.invoke({
      contractVersion: 1 as const,
      correlation: { requestId: "req-9", userId: "user-1" },
      toolCallId: "call-9",
      toolName: EXPLORE_WEBSITE_TOOL_NAME,
      arguments: { url: "https://example.com/stays", goal: "compare stays" },
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ phase: "request", toolName: EXPLORE_WEBSITE_TOOL_NAME, requestId: "req-9" });
    expect(records[0]!.deadlineMs).toBe(resolveToolTimeoutMs(EXPLORE_WEBSITE_TOOL_NAME));
    expect(records[0]!.elapsedMs).toEqual(expect.any(Number));
    // A structured service error keeps its own typed code through the log.
    expect(records[1]).toMatchObject({ phase: "response", failure: "service_reported", errorCode: "TIMEOUT" });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("launch-secret");
    // Never the arguments: a URL may carry untrusted query values.
    expect(serialized).not.toContain("example.com/stays");
  });
});

describe("typed tool-execution error mapping (P03-R01 steps 3-4)", () => {
  it("reports an exhausted deadline as a retryable TIMEOUT", () => {
    const classified = classifyToolExecutionError(new BrowserServiceTimeoutError("timed out"))!;
    expect(classified.errorCode).toBe("TIMEOUT");
    expect(classified.retryable).toBe(true);
    expect(classified.category).toBe("browser_service_timeout");
    // Acceptance item 8: the reported message must no longer be this one.
    expect(classified.message).not.toContain("The tool could not complete safely");
  });

  it("reports an unreachable service as a retryable UPSTREAM_UNAVAILABLE", () => {
    const classified = classifyToolExecutionError(new BrowserServiceUnavailableError("down"))!;
    expect(classified.errorCode).toBe("UPSTREAM_UNAVAILABLE");
    expect(classified.retryable).toBe(true);
  });

  it("reports an unusable service response as a non-retryable upstream failure", () => {
    const classified = classifyToolExecutionError(new BrowserServiceContractError("bad shape"))!;
    expect(classified.errorCode).toBe("UPSTREAM_UNAVAILABLE");
    expect(classified.retryable).toBe(false);
    expect(classified.category).toBe("browser_service_contract");
  });

  it("separates caller cancellation from a deadline", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyToolExecutionError(abort)!.errorCode).toBe("CANCELLED");
    // `AbortSignal.timeout` raises TimeoutError, which is not cancellation.
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(classifyToolExecutionError(timeout)).toBeNull();
  });

  it("reports invalid tool input as INVALID_ARGUMENTS and never retries it", () => {
    for (const error of [new SyntaxError("bad json"), new z.ZodError([])]) {
      const classified = classifyToolExecutionError(error)!;
      expect(classified.errorCode).toBe("INVALID_ARGUMENTS");
      expect(classified.retryable).toBe(false);
    }
  });

  it("still fails closed as INTERNAL for a genuinely unexpected defect", () => {
    expect(classifyToolExecutionError(new RangeError("off by one"))).toBeNull();
    const classified = classifyToolExecutionErrorOrInternal(new RangeError("off by one"));
    expect(classified.errorCode).toBe("INTERNAL");
    expect(classified.category).toBe("unexpected");
  });

  it("never leaks the underlying exception text into the user-facing message", () => {
    const secretish = "ECONNREFUSED 127.0.0.1:8020 while parsing <div>untrusted page text</div>";
    for (const error of [
      new BrowserServiceTimeoutError(secretish),
      new BrowserServiceUnavailableError(secretish),
      new BrowserServiceContractError(secretish),
      new RangeError(secretish),
    ]) {
      const { message } = classifyToolExecutionErrorOrInternal(error);
      expect(message).not.toContain("ECONNREFUSED");
      expect(message).not.toContain("untrusted page text");
      expect(message.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_LENGTH);
    }
  });

  it("tells the user nothing was changed, since every tool here is read-only", () => {
    for (const error of [
      new BrowserServiceTimeoutError("x"),
      new BrowserServiceUnavailableError("x"),
      new BrowserServiceContractError("x"),
      new SyntaxError("x"),
      new RangeError("x"),
    ]) {
      expect(classifyToolExecutionErrorOrInternal(error).message).toContain("Nothing was changed");
    }
  });
});
