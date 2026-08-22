import { describe, expect, it } from "vitest";
import { CONTRACT_MAJOR_VERSION } from "../src/version.js";
import { SystemEchoInvocationSchema } from "../src/invocation.js";
import { CancellationRequestSchema } from "../src/cancellation.js";

const baseCorrelation = {
  requestId: "req-0001",
  userId: "user-0001",
  sessionId: "sess-0001",
  taskId: "task-0001",
};

describe("contractVersion enforcement", () => {
  it("sanity: CONTRACT_MAJOR_VERSION is 1 (bump this test's expectations along with a real major bump)", () => {
    expect(CONTRACT_MAJOR_VERSION).toBe(1);
  });

  it("accepts a payload whose contractVersion matches the current major version", () => {
    const result = SystemEchoInvocationSchema.safeParse({
      contractVersion: CONTRACT_MAJOR_VERSION,
      correlation: baseCorrelation,
      toolCallId: "call-0001",
      toolName: "system.echo",
      arguments: { message: "hi" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload with a future/mismatched major contractVersion", () => {
    const result = SystemEchoInvocationSchema.safeParse({
      contractVersion: CONTRACT_MAJOR_VERSION + 1,
      correlation: baseCorrelation,
      toolCallId: "call-0001",
      toolName: "system.echo",
      arguments: { message: "hi" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "contractVersion");
      expect(issue).toBeDefined();
    }
  });

  it("rejects an old-shape payload missing contractVersion entirely", () => {
    const result = SystemEchoInvocationSchema.safeParse({
      correlation: baseCorrelation,
      toolCallId: "call-0001",
      toolName: "system.echo",
      arguments: { message: "hi" },
    });
    expect(result.success).toBe(false);
  });

  it("applies the same version enforcement to every envelope schema (spot check: cancellation request)", () => {
    const result = CancellationRequestSchema.safeParse({
      contractVersion: 999,
      correlation: baseCorrelation,
    });
    expect(result.success).toBe(false);
  });
});
