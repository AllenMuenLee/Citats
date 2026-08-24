import { createHash } from "node:crypto";
import type { UiCommandResult } from "../../../../../packages/contracts/src/ui/ui-command";
import { uiCommandSchema } from "../../../../../packages/contracts/src/ui/ui-command";
import { InMemoryUiInstanceStore } from "./instance-store";

export interface ReadOnlyCommandContext {
  sessionId: string;
  ownerId: string;
  correlationId: string;
  originalInvocationId: string;
  sourceIds: readonly string[];
}

export type ReadOnlyExecutor = (arguments_: unknown, context: ReadOnlyCommandContext) => Promise<unknown>;
export type ReadOnlyExecutors = Readonly<Record<"products.search" | "flights.search" | "flights.detail", ReadOnlyExecutor>>;

interface CachedResult { fingerprint: string; result: UiCommandResult; expiresAt: number }
interface RateBucket { timestamps: number[] }

function failure(code: Extract<UiCommandResult, { ok: false }>["code"], message: string, refreshRequired = false, retryAfterMs?: number): UiCommandResult {
  return { ok: false, code, message, refresh_required: refreshRequired, ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }) };
}

export class UiCommandHandler {
  private readonly idempotency = new Map<string, CachedResult>();
  private readonly rate = new Map<string, RateBucket>();

  constructor(
    private readonly instances: InMemoryUiInstanceStore,
    private readonly executors: ReadOnlyExecutors,
    private readonly now: () => number = Date.now,
    private readonly rateLimit = 10,
    private readonly rateWindowMs = 60_000,
  ) {}

  async execute(raw: unknown, identity: { sessionId: string; ownerId: string }): Promise<UiCommandResult> {
    const envelope = uiCommandSchema.safeParse(raw);
    if (!envelope.success) return failure("invalid_command", "The component command is invalid.");
    const command = envelope.data;
    const instance = this.instances.get(command.component_instance_id);
    if (!instance) return failure("expired", "This generated result has expired. Refresh it to continue.", true);
    if (instance.expiresAt <= this.now()) {
      this.instances.delete(instance.instanceId);
      return failure("expired", "This generated result has expired. Refresh it to continue.", true);
    }
    if (instance.ownerId !== identity.ownerId || instance.sessionId !== identity.sessionId) return failure("forbidden", "This component does not belong to this session.");
    if (instance.componentType !== command.component_type || instance.schemaVersion !== command.schema_version || instance.resultDigest !== command.originating_result_digest) {
      return failure("stale", "The component no longer matches its server result. Refresh it to continue.", true);
    }
    const mapping = instance.commands[command.command_type];
    if (!mapping) return failure("invalid_command", "That command is not allowed for this component.");
    const argumentsResult = mapping.argumentSchema.safeParse(command.arguments);
    if (!argumentsResult.success) return failure("invalid_arguments", "The command arguments are invalid.");

    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const cacheKey = command.idempotency_key ? `${identity.sessionId}:${instance.instanceId}:${command.command_type}:${command.idempotency_key}` : undefined;
    if (cacheKey) {
      const cached = this.idempotency.get(cacheKey);
      if (cached && cached.expiresAt > this.now()) {
        if (cached.fingerprint !== fingerprint) return failure("invalid_command", "The idempotency key was already used for a different command.");
        return cached.result.ok ? { ...cached.result, replayed: true } : cached.result;
      }
    }

    const retryAfter = this.consumeRate(identity.sessionId, instance.instanceId);
    if (retryAfter !== undefined) return failure("rate_limited", "Too many component commands. Try again shortly.", false, retryAfter);
    const sourceIds = instance.provenance.sources.map((source) => source.source_id);
    const result = await this.executors[mapping.tool](argumentsResult.data, {
      sessionId: identity.sessionId,
      ownerId: identity.ownerId,
      correlationId: command.correlation_id,
      originalInvocationId: instance.provenance.invocation_id,
      sourceIds,
    });
    const response: UiCommandResult = {
      ok: true,
      component_instance_id: instance.instanceId,
      correlation_id: command.correlation_id,
      relationship: mapping.relationship,
      result,
      provenance: { invocation_id: instance.provenance.invocation_id, source_ids: sourceIds },
      replayed: false,
    };
    if (cacheKey) this.idempotency.set(cacheKey, { fingerprint, result: response, expiresAt: instance.expiresAt });
    return response;
  }

  private consumeRate(sessionId: string, instanceId: string): number | undefined {
    const key = `${sessionId}:${instanceId}`;
    const cutoff = this.now() - this.rateWindowMs;
    const bucket = this.rate.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((timestamp) => timestamp > cutoff);
    if (bucket.timestamps.length >= this.rateLimit) return Math.max(1, bucket.timestamps[0] + this.rateWindowMs - this.now());
    bucket.timestamps.push(this.now());
    this.rate.set(key, bucket);
    return undefined;
  }
}
