import { randomUUID } from "node:crypto";
import { z, type ZodType } from "zod";
import type { CapabilityArgument, CompiledGeneratedUiArtifact, UiGenerationRequest, WebsiteUiExternalCapability } from "@ai-browser/contracts";

export type UiInstanceCapability = Readonly<{
  kinds: readonly string[];
  argumentSchema: ZodType;
  /** `internal_react` capabilities never reach the host; a command for one is a policy violation. */
  interactionExecution: "internal_react" | "external_ai_action";
  promptTemplateId: string | null;
  external: WebsiteUiExternalCapability | null;
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

/**
 * The reconstructed AI action prompt for one external command (P04-F05
 * step 3). Built server-side from the capability's validated template plus
 * schema-checked arguments -- never from a prompt the generated component
 * supplied, and never carrying a selector, URL, credential, or payment
 * detail. Phase 5 owns whether it is ever executed.
 */
export type ReconstructedAction = Readonly<{
  capabilityId: string;
  promptTemplateId: string;
  prompt: string;
  requiresConfirmation: boolean;
  confirmationFields: readonly string[];
  destinationOrigin: string | null;
  paymentProfileHandle: string | null;
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

  /**
   * Validates one command and reconstructs the action it stands for.
   *
   * Everything the generated component sent is treated as a claim: the
   * instance, revision, capability, execution class, prompt-template id,
   * and every argument are checked against server-held state before the
   * prompt is rebuilt from the trusted template.
   */
  validateCommand(input: { instanceId: string; ownerId: string; revision: number; capabilityId: string; promptTemplateId?: string | null; kind: string; arguments: unknown }): { instance: GeneratedUiInstance; action: ReconstructedAction } {
    const instance = this.get(input.instanceId, input.ownerId);
    if (!instance) throw new Error("generated UI instance is missing or expired");
    if (input.revision !== instance.revision) throw new Error("generated UI command revision is stale");
    const capability = instance.capabilities.get(input.capabilityId);
    if (!capability || !capability.kinds.includes(input.kind)) throw new Error("generated UI command is not allowed");
    if (capability.interactionExecution !== "external_ai_action" || capability.external === null) {
      throw new Error("internal interactions must stay inside the generated component");
    }
    if ((input.promptTemplateId ?? null) !== capability.promptTemplateId) {
      throw new Error("generated UI command prompt template does not match its capability");
    }
    const parsed = capability.argumentSchema.parse(input.arguments) as Record<string, string | number | boolean>;
    return { instance, action: reconstructAction(capability.external, parsed) };
  }

  destroy(instanceId: string, ownerId: string): void {
    const instance = this.instances.get(instanceId);
    if (instance?.ownerId === ownerId) this.instances.delete(instanceId);
  }
}

export const generatedUiInstances = new GeneratedUiInstanceStore();

/** One `CapabilityArgument` as the Zod type the host validates a command's arguments against. */
function argumentType(argument: CapabilityArgument): ZodType {
  switch (argument.type) {
    case "number": return z.number().finite();
    case "boolean": return z.boolean();
    case "enum": return z.enum(argument.values as [string, ...string[]]);
    default: return z.string().max(2_000);
  }
}

function argumentsSchema(declared: readonly CapabilityArgument[]): ZodType {
  if (declared.length === 0) return z.object({}).strict();
  return z.object(Object.fromEntries(declared.map((argument) => [
    argument.name,
    argument.required ? argumentType(argument) : argumentType(argument).optional(),
  ]))).strict();
}

/**
 * Fills the capability's validated template from schema-checked arguments.
 * A placeholder with no supplied argument becomes an explicit
 * `(unspecified)` rather than being dropped, so the later action agent can
 * see that the user left it open instead of silently inferring one.
 */
export function reconstructAction(
  external: WebsiteUiExternalCapability,
  args: Readonly<Record<string, string | number | boolean>>,
): ReconstructedAction {
  const prompt = external.promptTemplate.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const value = args[name];
    return value === undefined ? "(unspecified)" : String(value).slice(0, 200);
  });
  return {
    capabilityId: external.capabilityId,
    promptTemplateId: external.promptTemplateId,
    prompt,
    requiresConfirmation: external.requiresConfirmation,
    confirmationFields: external.confirmationFields,
    destinationOrigin: external.destinationOrigin,
    paymentProfileHandle: external.paymentProfileHandle,
  };
}

export function capabilitySchemasForRequest(request: UiGenerationRequest): ReadonlyMap<string, UiInstanceCapability> {
  const externalById = new Map(request.websiteUiMetadata.externalCapabilities.map((item) => [item.capabilityId, item]));
  return new Map(request.capabilityBindings.map((binding) => {
    const external = externalById.get(binding.capabilityId) ?? null;
    return [binding.capabilityId, {
      kinds: binding.allowedCommandKinds,
      argumentSchema: argumentsSchema(external?.argumentSchema ?? []),
      interactionExecution: binding.interactionExecution,
      promptTemplateId: binding.promptTemplateId,
      external,
    }];
  }));
}
