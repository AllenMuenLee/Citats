import { randomUUID } from "node:crypto";
import { z, type ZodType } from "zod";
import type { CompiledGeneratedUiArtifact, UiGenerationRequest } from "@ai-browser/contracts";

export type UiInstanceCapability = Readonly<{
  kinds: readonly string[];
  argumentSchema: ZodType;
}>;

export type GeneratedUiInstance = Readonly<{
  instanceId: string;
  ownerId: string;
  artifact: CompiledGeneratedUiArtifact;
  request: UiGenerationRequest;
  observationDigest: string;
  revision: number;
  expiresAt: number;
  capabilities: ReadonlyMap<string, UiInstanceCapability>;
  preservedStateKeys: readonly string[];
  displayProps: Readonly<Record<string, unknown>>;
}>;

export class GeneratedUiInstanceStore {
  private readonly instances = new Map<string, GeneratedUiInstance>();

  constructor(private readonly now: () => number = Date.now, private readonly createId: () => string = randomUUID) {}

  register(input: Omit<GeneratedUiInstance, "instanceId" | "revision">): GeneratedUiInstance {
    const instance = Object.freeze({ ...input, instanceId: this.createId(), revision: 0 });
    this.instances.set(instance.instanceId, instance);
    return instance;
  }

  get(instanceId: string, ownerId: string): GeneratedUiInstance | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.ownerId !== ownerId) return undefined;
    if (instance.expiresAt <= this.now()) {
      this.instances.delete(instanceId);
      return undefined;
    }
    return instance;
  }

  updateBindings(instanceId: string, ownerId: string, observationDigest: string, displayProps: Readonly<Record<string, unknown>>): GeneratedUiInstance {
    const current = this.get(instanceId, ownerId);
    if (!current) throw new Error("generated UI instance is missing or expired");
    const next = Object.freeze({ ...current, observationDigest, displayProps, revision: current.revision + 1 });
    this.instances.set(instanceId, next);
    return next;
  }

  validateCommand(input: { instanceId: string; ownerId: string; revision: number; capabilityId: string; kind: string; arguments: unknown }): GeneratedUiInstance {
    const instance = this.get(input.instanceId, input.ownerId);
    if (!instance) throw new Error("generated UI instance is missing or expired");
    if (input.revision !== instance.revision) throw new Error("generated UI command revision is stale");
    const capability = instance.capabilities.get(input.capabilityId);
    if (!capability || !capability.kinds.includes(input.kind)) throw new Error("generated UI command is not allowed");
    capability.argumentSchema.parse(input.arguments);
    return instance;
  }

  destroy(instanceId: string, ownerId: string): void {
    const instance = this.instances.get(instanceId);
    if (instance?.ownerId === ownerId) this.instances.delete(instanceId);
  }
}

export const generatedUiInstances = new GeneratedUiInstanceStore();

export function capabilitySchemasForRequest(request: UiGenerationRequest): ReadonlyMap<string, UiInstanceCapability> {
  return new Map(request.capabilityBindings.map((binding) => [binding.capabilityId, {
    kinds: binding.allowedCommandKinds,
    argumentSchema: z.record(z.string().max(100), z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()])),
  }]));
}
