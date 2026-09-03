import { describe, expect, it } from "vitest";
import { GENERATED_UI_BRIDGE_VERSION } from "../../src/server/generative-ui/bridge/protocol";
import { BridgeMessageValidator, type BridgeInstance } from "../../src/server/generative-ui/bridge/validator";

function instance(): BridgeInstance {
  return {
    channel: "channel-1",
    instanceId: "instance-1",
    artifactId: `gui_${"a".repeat(64)}`,
    implementationPromptDigest: "b".repeat(64),
    inputDigest: "c".repeat(64),
    revision: 2,
    expiresAt: 10_000,
  };
}

function message(type: "ready" | "resize" | "telemetry" = "ready", sequence = 1): Record<string, unknown> {
  const value = instance();
  return {
    bridgeVersion: GENERATED_UI_BRIDGE_VERSION,
    channel: value.channel,
    instanceId: value.instanceId,
    artifactId: value.artifactId,
    implementationPromptDigest: value.implementationPromptDigest,
    inputDigest: value.inputDigest,
    revision: value.revision,
    sequence,
    type,
    ...(type === "resize" ? { height: 400 } : {}),
    ...(type === "telemetry" ? { event: "rendered", code: null } : {}),
  };
}

describe("generated UI bridge boundary", () => {
  it("accepts the four permitted outbound message types", () => {
    for (const type of ["ready", "resize", "telemetry"] as const) {
      expect(new BridgeMessageValidator(instance()).validate(message(type), 1_000).type).toBe(type);
    }
  });

  /**
   * P04-F04 step 3: there is no action or website-command channel. A message
   * shaped like one is not partially honoured -- it fails the closed union.
   */
  it("rejects a command message outright", () => {
    const forged = {
      ...message(),
      type: "command",
      command: { kind: "activate", capabilityId: "cap-1", promptTemplateId: "tpl-1", arguments: {} },
    };
    expect(() => new BridgeMessageValidator(instance()).validate(forged, 1_000)).toThrow();
  });

  it.each(["channel", "instanceId", "artifactId", "implementationPromptDigest", "inputDigest", "revision"])("rejects forged %s", (field) => {
    const value = message();
    value[field] = field === "revision" ? 3 : "forged";
    expect(() => new BridgeMessageValidator(instance()).validate(value, 1_000)).toThrow();
  });

  it("rejects a message from an older bridge version", () => {
    const value = message();
    value.bridgeVersion = 1;
    expect(() => new BridgeMessageValidator(instance()).validate(value, 1_000)).toThrow();
  });

  it("rejects stale and out-of-order sequences", () => {
    const validator = new BridgeMessageValidator(instance());
    validator.validate(message("ready", 1), 1_000);
    expect(() => validator.validate(message("resize", 1), 1_001)).toThrow(/sequence/);
    expect(() => validator.validate(message("resize", 5), 1_001)).toThrow(/sequence/);
  });

  it("rejects an unknown field on an otherwise valid message", () => {
    const value = { ...message(), extra: "surprise" };
    expect(() => new BridgeMessageValidator(instance()).validate(value, 1_000)).toThrow();
  });

  it("rejects expiry, oversized payloads, and floods", () => {
    expect(() => new BridgeMessageValidator(instance()).validate(message(), 10_000)).toThrow(/expired/);

    const large = { ...message("telemetry"), code: "x".repeat(17_000) };
    expect(() => new BridgeMessageValidator(instance()).validate(large, 1_000)).toThrow(/size/);

    const validator = new BridgeMessageValidator(instance(), 1);
    validator.validate(message("ready", 1), 1_000);
    expect(() => validator.validate(message("resize", 2), 1_001)).toThrow(/rate/);
  });
});
