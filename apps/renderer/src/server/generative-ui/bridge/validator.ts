import type { ZodType } from "zod";
import { GeneratedUiMessageSchema, MAX_BRIDGE_MESSAGE_BYTES, type GeneratedUiMessage } from "./protocol";

export type BridgeCapability = Readonly<{ kinds: ReadonlySet<string>; argumentSchema: ZodType; promptTemplateId: string | null }>;
export type BridgeInstance = Readonly<{
  channel: string;
  instanceId: string;
  artifactId: string;
  inputDigest: string;
  observationDigest: string;
  revision: number;
  expiresAt: number;
  capabilities: ReadonlyMap<string, BridgeCapability>;
}>;

export class BridgeMessageValidator {
  private sequence = 0;
  private windowStartedAt = 0;
  private count = 0;

  constructor(private readonly instance: BridgeInstance, private readonly maxPerSecond = 30) {}

  validate(value: unknown, now = Date.now()): GeneratedUiMessage {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > MAX_BRIDGE_MESSAGE_BYTES) throw new Error("bridge message exceeds size limit");
    const message = GeneratedUiMessageSchema.parse(value);
    if (now >= this.instance.expiresAt) throw new Error("generated UI instance expired");
    for (const key of ["channel", "instanceId", "artifactId", "inputDigest", "observationDigest", "revision"] as const) {
      if (message[key] !== this.instance[key]) throw new Error(`bridge ${key} mismatch`);
    }
    if (message.sequence !== this.sequence + 1) throw new Error("bridge sequence is stale or out of order");
    if (now - this.windowStartedAt >= 1_000) { this.windowStartedAt = now; this.count = 0; }
    if (++this.count > this.maxPerSecond) throw new Error("bridge message rate exceeded");
    if (message.type === "command") {
      const binding = this.instance.capabilities.get(message.command.capabilityId);
      if (!binding || !binding.kinds.has(message.command.kind)) throw new Error("command is not capability-bound");
      // An internal-only capability has no template, so a command naming one
      // can never match -- which is the intended outcome: React-only
      // interactions must never cross the bridge at all.
      if (binding.promptTemplateId !== message.command.promptTemplateId) throw new Error("command prompt template is not capability-bound");
      binding.argumentSchema.parse(message.command.arguments);
    }
    this.sequence = message.sequence;
    return message;
  }
}
