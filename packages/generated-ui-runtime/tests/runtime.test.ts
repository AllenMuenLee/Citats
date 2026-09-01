import { describe, expect, it } from "vitest";
import { CommandButton, semanticTokens, type GeneratedViewProps, type OpaqueId } from "../src/index";

const opaque = (value: string) => value as OpaqueId;

describe("generated UI runtime authority", () => {
  it("emits a revision-bound opaque command only for an allowed external capability", () => {
    const commands: unknown[] = [];
    const capability = { id: opaque("cap-1"), allowedCommandKinds: ["activate"] as const, execution: "external_ai_action" as const, promptTemplateId: opaque("tpl-1") };
    const runtime = {
      instanceRevision: 7, records: [], sources: [], media: [], capabilities: [capability],
      getRecord: () => undefined, getSource: () => undefined, getMedia: () => undefined,
      getCapability: (id: OpaqueId) => id === capability.id ? capability : undefined,
      dispatchCommand: (command: unknown) => commands.push(command),
    } as GeneratedViewProps;
    const element = CommandButton({ runtime, capabilityId: capability.id, kind: "activate", arguments: { index: 2 }, children: "Open" });
    expect(element.props.disabled).toBe(false);
    element.props.onClick();
    expect(commands).toEqual([{ kind: "activate", capabilityId: "cap-1", promptTemplateId: "tpl-1", revision: 7, arguments: { index: 2 } }]);
    expect(Object.isFrozen(commands[0])).toBe(true);
  });

  it("disables forged command bindings and freezes tokens", () => {
    const runtime = { instanceRevision: 1, records: [], sources: [], media: [], capabilities: [], getRecord: () => undefined, getSource: () => undefined, getMedia: () => undefined, getCapability: () => undefined, dispatchCommand: () => { throw new Error("must not dispatch"); } } as GeneratedViewProps;
    const element = CommandButton({ runtime, capabilityId: opaque("forged"), kind: "activate", children: "Open" });
    expect(element.props.disabled).toBe(true);
    element.props.onClick();
    expect(Object.isFrozen(semanticTokens)).toBe(true);
  });

  it("refuses to dispatch for a React-only capability", () => {
    // An internal interaction has no prompt template, so there is nothing for
    // the host to reconstruct -- the control is inert rather than "allowed".
    const capability = { id: opaque("cap-local"), allowedCommandKinds: ["select"] as const, execution: "internal_react" as const, promptTemplateId: null };
    const runtime = {
      instanceRevision: 3, records: [], sources: [], media: [], capabilities: [capability],
      getRecord: () => undefined, getSource: () => undefined, getMedia: () => undefined,
      getCapability: (id: OpaqueId) => id === capability.id ? capability : undefined,
      dispatchCommand: () => { throw new Error("must not dispatch"); },
    } as GeneratedViewProps;
    const element = CommandButton({ runtime, capabilityId: capability.id, kind: "select", children: "Sort" });
    expect(element.props.disabled).toBe(true);
    element.props.onClick();
  });
});
