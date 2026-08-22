import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BrowserServiceClient } from "../src/server/browser-service/client";
import {
  BrowserServiceContractError,
  BrowserServiceTimeoutError,
  BrowserServiceUnavailableError,
} from "../src/server/browser-service/errors";
import { redactForLog } from "../src/server/browser-service/redaction";

const invocation = {
  contractVersion: 1 as const,
  correlation: { requestId: "req-1", userId: "user-1" },
  toolCallId: "call-1",
  toolName: "system.echo" as const,
  arguments: { message: "hello" },
};

const success = {
  contractVersion: 1,
  correlation: invocation.correlation,
  toolCallId: invocation.toolCallId,
  status: "success",
  payload: { message: "hello" },
  sensitivity: { sensitive: false, confirmationRequired: false },
};

describe("BrowserServiceClient", () => {
  it("authenticates, propagates request IDs, and validates success", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get("x-service-token")).toBe("launch-secret");
      expect(new Headers(init?.headers).get("x-request-id")).toBe("req-1");
      return Response.json(success);
    });
    const client = new BrowserServiceClient({ baseUrl: "http://127.0.0.1:8123", serviceToken: "launch-secret", fetchImpl });
    await expect(client.invoke(invocation)).resolves.toEqual(success);
  });

  it("rejects non-loopback targets", () => {
    expect(() => new BrowserServiceClient({ baseUrl: "https://example.com", serviceToken: "x" })).toThrow(TypeError);
  });

  it("normalizes unavailable and malformed responses", async () => {
    const unavailable = new BrowserServiceClient({ baseUrl: "http://localhost:1", serviceToken: "x", fetchImpl: vi.fn(async () => { throw new TypeError("down"); }) });
    await expect(unavailable.invoke(invocation)).rejects.toBeInstanceOf(BrowserServiceUnavailableError);
    const malformed = new BrowserServiceClient({ baseUrl: "http://localhost:1", serviceToken: "x", fetchImpl: vi.fn(async () => Response.json({ nope: true })) });
    await expect(malformed.invoke(invocation)).rejects.toBeInstanceOf(BrowserServiceContractError);
  });

  it("normalizes timeouts", async () => {
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const client = new BrowserServiceClient({ baseUrl: "http://localhost:1", serviceToken: "x", timeoutMs: 5, fetchImpl });
    await expect(client.invoke(invocation)).rejects.toBeInstanceOf(BrowserServiceTimeoutError);
  });

  it("recursively redacts secret-shaped log fields", () => {
    expect(redactForLog({ token: "secret", nested: { authorization: "Bearer secret" } })).toEqual({
      token: "[REDACTED]",
      nested: { authorization: "[REDACTED]" },
    });
  });
});
