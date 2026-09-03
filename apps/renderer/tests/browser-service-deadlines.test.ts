import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  EXPLORE_WEBSITE_TOOL_NAME,
  ERROR_MESSAGE_MAX_LENGTH,
} from "@ai-browser/contracts";
import { BrowserServiceClient } from "../src/server/browser-service/client";
import {
  BrowserServiceContractError,
  BrowserServiceTimeoutError,
  BrowserServiceUnavailableError,
} from "../src/server/browser-service/errors";
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
describe("browser-service bridge logging (P03-R01 step 5)", () => {
  it("records phase, tool, correlation, and elapsed without the service token", async () => {
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
    expect(records[0]).not.toHaveProperty("deadlineMs");
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
