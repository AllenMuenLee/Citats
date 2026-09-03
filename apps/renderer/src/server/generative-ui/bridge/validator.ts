import { GeneratedUiMessageSchema, MAX_BRIDGE_MESSAGE_BYTES, type GeneratedUiMessage } from "./protocol";

/**
 * Validates every message coming out of one sandboxed surface (P04-F04
 * step 3).
 *
 * Ownership, channel, artifact, both digests, revision, sequence, rate, and
 * size are all checked against server-held state before a message is acted
 * on -- so a forged, replayed, stale, or flooding message is rejected
 * rather than believed. There is no command arm any more: the surface has
 * nothing to ask for.
 */
export type BridgeInstance = Readonly<{
  channel: string;
  instanceId: string;
  artifactId: string;
  implementationPromptDigest: string;
  inputDigest: string;
  revision: number;
  expiresAt: number;
}>;

export class BridgeMessageValidator {
  private sequence = 0;
  private windowStartedAt = 0;
  private count = 0;

  constructor(private readonly instance: BridgeInstance, private readonly maxPerSecond = 30) {}

  validate(value: unknown, now = Date.now()): GeneratedUiMessage {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
      throw new Error("bridge message exceeds size limit");
    }
    const message = GeneratedUiMessageSchema.parse(value);
    if (now >= this.instance.expiresAt) throw new Error("generated UI instance expired");
    for (const key of ["channel", "instanceId", "artifactId", "implementationPromptDigest", "inputDigest", "revision"] as const) {
      if (message[key] !== this.instance[key]) throw new Error(`bridge ${key} mismatch`);
    }
    if (message.sequence !== this.sequence + 1) throw new Error("bridge sequence is stale or out of order");
    if (now - this.windowStartedAt >= 1_000) {
      this.windowStartedAt = now;
      this.count = 0;
    }
    if (++this.count > this.maxPerSecond) throw new Error("bridge message rate exceeded");
    this.sequence = message.sequence;
    return message;
  }
}
