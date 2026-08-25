import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BridgeMessageValidator, type BridgeInstance } from "../../src/server/generative-ui/bridge/validator";

function instance(): BridgeInstance {
  return { channel: "channel-1", instanceId: "instance-1", artifactId: `gui_${"a".repeat(64)}`, inputDigest: "b".repeat(64), observationDigest: "c".repeat(64), revision: 2, expiresAt: 10_000, capabilities: new Map([["cap-1", { kinds: new Set(["activate"]), argumentSchema: z.object({ recordId: z.string().max(20) }).strict() }]]) };
}

function message(sequence = 1): unknown {
  const value = instance();
  return { bridgeVersion: 1, channel: value.channel, instanceId: value.instanceId, artifactId: value.artifactId, inputDigest: value.inputDigest, observationDigest: value.observationDigest, revision: value.revision, sequence, type: "command", command: { kind: "activate", capabilityId: "cap-1", arguments: { recordId: "record-1" } } };
}

describe("generated UI bridge boundary", () => {
  it("accepts one capability-bound command", () => expect(new BridgeMessageValidator(instance()).validate(message(), 1_000).type).toBe("command"));
  it.each(["channel", "instanceId", "artifactId", "inputDigest", "observationDigest", "revision"])("rejects forged %s", (field) => { const value = message() as Record<string, unknown>; value[field] = field === "revision" ? 3 : "forged"; expect(() => new BridgeMessageValidator(instance()).validate(value, 1_000)).toThrow(); });
  it("rejects stale sequences", () => { const validator = new BridgeMessageValidator(instance()); validator.validate(message(), 1_000); expect(() => validator.validate(message(), 1_001)).toThrow(/sequence/); });
  it("rejects command tampering", () => { const value = message() as { command: { kind: string; arguments: Record<string, unknown> } }; value.command.kind = "set_value"; expect(() => new BridgeMessageValidator(instance()).validate(value, 1_000)).toThrow(/capability/); value.command.kind = "activate"; value.command.arguments.secret = "no"; expect(() => new BridgeMessageValidator(instance()).validate(value, 1_000)).toThrow(); });
  it("rejects expiry, oversized payloads, and floods", () => { expect(() => new BridgeMessageValidator(instance()).validate(message(), 10_000)).toThrow(/expired/); const large = message() as { command: { arguments: Record<string, unknown> } }; large.command.arguments.recordId = "x".repeat(17_000); expect(() => new BridgeMessageValidator(instance()).validate(large, 1_000)).toThrow(/size/); const validator = new BridgeMessageValidator(instance(), 1); validator.validate(message(), 1_000); expect(() => validator.validate(message(2), 1_001)).toThrow(/rate/); });
});
