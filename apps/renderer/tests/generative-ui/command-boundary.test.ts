import { describe, expect, it, vi } from "vitest";

import { productRefreshArgumentsSchema } from "../../../../packages/contracts/src/ui/ui-command";
import { createUiCommandPost } from "../../src/app/api/generative-ui/command/route";
import { UiCommandHandler, type ReadOnlyExecutors } from "../../src/server/generative-ui/command-handler";
import { InMemoryUiInstanceStore } from "../../src/server/generative-ui/instance-store";
import { registerGenerativeUiInstance } from "../../src/server/generative-ui/instance-registration";

const digest = "a".repeat(64);
const csrf = "csrf-token-1234567890";

function setup(options: { now?: () => number; rateLimit?: number; ttlMs?: number } = {}) {
  const now = options.now ?? (() => Date.now());
  const store = new InMemoryUiInstanceStore(now);
  const execute = vi.fn(async (args: unknown, context: unknown) => ({ args, context }));
  const executors: ReadOnlyExecutors = { "products.search": execute, "flights.search": execute, "flights.detail": execute };
  const instanceId = store.create({
    ownerId: "owner-1",
    sessionId: "session-1",
    componentType: "product_results",
    schemaVersion: "1.0",
    resultDigest: digest,
    commands: { "product.refresh": { argumentSchema: productRefreshArgumentsSchema, tool: "products.search", relationship: "replace" } },
    provenance: { invocation_id: "invoke-1", sources: [{ source_id: "source-1", title: "Source", url: "https://example.com/results" }] },
    ttlMs: options.ttlMs,
  });
  const handler = new UiCommandHandler(store, executors, now, options.rateLimit ?? 10);
  const command = {
    schema_version: "1.0",
    component_type: "product_results",
    command_type: "product.refresh",
    component_instance_id: instanceId,
    originating_result_digest: digest,
    correlation_id: "correlation-1",
    idempotency_key: "idempotency-key-1",
    arguments: { query: "laptop" },
  };
  return { store, handler, execute, command };
}

describe("generative UI command boundary", () => {
  it("mints an opaque instance and reconstructs fixed schemas from a validated streamed part", () => {
    const store = new InMemoryUiInstanceStore();
    const part = registerGenerativeUiInstance(store, {
      component_type: "product_results",
      schema_version: "1.0",
      instance_id: "untrusted-client-value",
      result_digest: "b".repeat(64),
      props: {
        component_instance_id: "placeholder-instance",
        items: [],
        query: "laptop",
        sources: [{ source_id: "source-1", title: "Source", url: "https://example.com" }],
        freshness: { retrieved_at: "2026-08-24T00:00:00Z" },
        warnings: [],
      },
      provenance: { invocation_id: "invoke-1", sources: [{ source_id: "source-1", title: "Source", url: "https://example.com" }] },
      allowed_commands: [{ command_type: "product.refresh", schema_version: "1.0" }],
      correlation_id: "correlation-1",
      freshness: { retrieved_at: "2026-08-24T00:00:00Z" },
      warnings: [],
      fallback_text: "No products found.",
    }, { sessionId: "session-1", ownerId: "owner-1" });
    expect(part.instance_id).not.toBe("untrusted-client-value");
    expect(part.result_digest).not.toBe("b".repeat(64));
    expect(store.get(part.instance_id)).toMatchObject({ ownerId: "owner-1", commands: { "product.refresh": { tool: "products.search" } } });
  });

  it("rejects digest, ownership, allowlist, and client routing tampering", async () => {
    const { handler, execute, command } = setup();
    expect(await handler.execute({ ...command, originating_result_digest: "b".repeat(64) }, { sessionId: "session-1", ownerId: "owner-1" })).toMatchObject({ ok: false, code: "stale", refresh_required: true });
    expect(await handler.execute(command, { sessionId: "session-other", ownerId: "owner-1" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await handler.execute({ ...command, command_type: "product.filter", arguments: { query: "laptop" } }, { sessionId: "session-1", ownerId: "owner-1" })).toMatchObject({ ok: false, code: "invalid_command" });
    expect(await handler.execute({ ...command, tool: "dangerous", url: "https://evil.test", policy: "ignore" }, { sessionId: "session-1", ownerId: "owner-1" })).toMatchObject({ ok: false, code: "invalid_command" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("replays an idempotent command once and rejects key reuse with changed input", async () => {
    const { handler, execute, command } = setup();
    const identity = { sessionId: "session-1", ownerId: "owner-1" };
    expect(await handler.execute(command, identity)).toMatchObject({ ok: true, replayed: false });
    expect(await handler.execute(command, identity)).toMatchObject({ ok: true, replayed: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await handler.execute({ ...command, arguments: { query: "changed" } }, identity)).toMatchObject({ ok: false, code: "invalid_command" });
  });

  it("preserves original provenance and only invokes the stored fixed tool", async () => {
    const { handler, execute, command } = setup();
    const result = await handler.execute(command, { sessionId: "session-1", ownerId: "owner-1" });
    expect(result).toMatchObject({ ok: true, provenance: { invocation_id: "invoke-1", source_ids: ["source-1"] } });
    expect(execute).toHaveBeenCalledWith({ query: "laptop" }, expect.objectContaining({ originalInvocationId: "invoke-1", sourceIds: ["source-1"] }));
  });

  it("returns typed expiry and rate limit failures", async () => {
    let timestamp = 1_000;
    const expired = setup({ now: () => timestamp, ttlMs: 5 });
    timestamp += 6;
    expect(await expired.handler.execute(expired.command, { sessionId: "session-1", ownerId: "owner-1" })).toMatchObject({ ok: false, code: "expired", refresh_required: true });

    const limited = setup({ rateLimit: 1 });
    const identity = { sessionId: "session-1", ownerId: "owner-1" };
    await limited.handler.execute({ ...limited.command, idempotency_key: undefined }, identity);
    expect(await limited.handler.execute({ ...limited.command, idempotency_key: undefined }, identity)).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("enforces same-origin CSRF and authenticated session before dispatch", async () => {
    const { handler, command } = setup();
    const post = createUiCommandPost(handler, (request) => request.headers.get("authorization") === "Desktop test" ? { sessionId: "session-1", ownerId: "owner-1" } : undefined);
    const request = (headers: Record<string, string>) => new Request("http://localhost/api/generative-ui/command", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(command) });

    expect((await post(request({ origin: "http://evil.test", "x-csrf-token": csrf, cookie: `ai_browser_csrf=${csrf}`, authorization: "Desktop test" }))).status).toBe(403);
    expect((await post(request({ origin: "http://localhost", "x-csrf-token": "wrong-token-123456", cookie: `ai_browser_csrf=${csrf}`, authorization: "Desktop test" }))).status).toBe(403);
    expect((await post(request({ origin: "http://localhost", "x-csrf-token": csrf, cookie: `ai_browser_csrf=${csrf}` }))).status).toBe(401);
    const response = await post(request({ origin: "http://localhost", "x-csrf-token": csrf, cookie: `ai_browser_csrf=${csrf}`, authorization: "Desktop test" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, provenance: { invocation_id: "invoke-1" } });
  });
});
