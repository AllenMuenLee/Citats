import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SystemEchoInvocationSchema } from "../src/invocation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "..", "fixtures");

describe("TypeScript-side round-trip", () => {
  it("constructs a valid invocation object matching fixtures/invocation/valid-1.json and validates it", () => {
    const constructed = {
      contractVersion: 1 as const,
      correlation: {
        requestId: "req-0001",
        userId: "user-0001",
        sessionId: "sess-0001",
        taskId: "task-0001",
      },
      toolCallId: "call-0001",
      toolName: "system.echo" as const,
      arguments: { message: "Hello, browser." },
    };

    const parsed = SystemEchoInvocationSchema.parse(constructed);
    expect(parsed).toEqual(constructed);

    const fixture = JSON.parse(readFileSync(join(FIXTURES_ROOT, "invocation", "valid-1.json"), "utf8"));
    expect(constructed).toEqual(fixture);

    // Serialize -> re-parse -> compare structurally (not necessarily
    // key-order-identical, matching the round-trip requirement the
    // Python-side test in services/browser mirrors against the same
    // fixture file).
    const roundTripped = JSON.parse(JSON.stringify(parsed));
    expect(roundTripped).toEqual(fixture);
  });
});
