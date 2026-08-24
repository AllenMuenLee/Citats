import { createHash, randomUUID } from "node:crypto";
import type { ZodType } from "zod";

import type { UiCommandType } from "../../../../../packages/contracts/src/ui/ui-command";
import type { UiProvenance } from "../../../../../packages/contracts/src/ui/common";

export interface UiInstanceCommand {
  argumentSchema: ZodType;
  tool: "products.search" | "flights.search" | "flights.detail";
  relationship: "replace" | "append";
}

export interface UiInstanceRecord {
  instanceId: string;
  ownerId: string;
  sessionId: string;
  componentType: "product_results" | "flight_comparison";
  schemaVersion: "1.0";
  resultDigest: string;
  commands: Readonly<Partial<Record<UiCommandType, UiInstanceCommand>>>;
  provenance: UiProvenance;
  expiresAt: number;
}

export interface CreateUiInstanceInput extends Omit<UiInstanceRecord, "instanceId" | "expiresAt"> {
  ttlMs?: number;
}

export function digestUiResult(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class InMemoryUiInstanceStore {
  private readonly records = new Map<string, UiInstanceRecord>();

  constructor(private readonly now: () => number = Date.now, private readonly defaultTtlMs = 5 * 60_000) {}

  create(input: CreateUiInstanceInput): string {
    this.prune();
    const instanceId = randomUUID();
    this.records.set(instanceId, Object.freeze({ ...input, instanceId, expiresAt: this.now() + (input.ttlMs ?? this.defaultTtlMs) }));
    return instanceId;
  }

  get(instanceId: string): UiInstanceRecord | undefined {
    return this.records.get(instanceId);
  }

  delete(instanceId: string): void {
    this.records.delete(instanceId);
  }

  prune(): void {
    const now = this.now();
    for (const [id, record] of this.records) if (record.expiresAt <= now) this.records.delete(id);
  }
}

export const uiCommandInstanceStore = new InMemoryUiInstanceStore();
