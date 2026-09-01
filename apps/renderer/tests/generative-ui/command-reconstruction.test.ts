import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { CompiledGeneratedUiArtifact } from "@ai-browser/contracts";
import { GeneratedUiInstanceStore, capabilitySchemasForRequest } from "../../src/server/generative-ui/instance-store";
import { buildImplementationPlan } from "../../src/server/generative-ui/implementation-plan";
import { buildUiGenerationRequest } from "../../src/server/generative-ui/request-builder";
import { buildExploreResult } from "../helpers/explore-result";

const artifact = { artifactId: `gui_${"a".repeat(64)}` } as unknown as CompiledGeneratedUiArtifact;

async function registered() {
  const result = buildExploreResult();
  const page = result.payload.pageUnderstanding;
  const brief = await buildImplementationPlan(undefined, { correlationId: "req-1", task: "Compare stays", result });
  const request = buildUiGenerationRequest({ task: "Compare stays", brief, page, requestId: "req-1", userId: "user-1" });
  const store = new GeneratedUiInstanceStore(() => 1_000, () => "instance-1");
  const instance = store.register({
    ownerId: "owner-1",
    artifact,
    request,
    observationDigest: page.observationDigest,
    expiresAt: 60_000,
    capabilities: capabilitySchemasForRequest(request),
    preservedStateKeys: [],
    displayProps: {},
  });
  const external = brief.metadata.externalCapabilities[0]!;
  const internal = brief.metadata.internalInteractions[0]!;
  return { store, instance, external, internal };
}

describe("external command reconstruction", () => {
  it("rebuilds the AI action prompt server-side from the capability's own template", async () => {
    const { store, external } = await registered();
    const { action } = store.validateCommand({
      instanceId: "instance-1",
      ownerId: "owner-1",
      revision: 0,
      capabilityId: external.capabilityId,
      promptTemplateId: external.promptTemplateId,
      kind: "activate",
      arguments: { selection: "record-3" },
    });
    expect(action.prompt).toContain("record-3");
    expect(action.prompt).not.toContain("{{");
    expect(action.promptTemplateId).toBe(external.promptTemplateId);
    expect(action.requiresConfirmation).toBe(true);
    // A payment profile is referenced by handle only -- never by its contents.
    expect(action.paymentProfileHandle).toBe("payment-profile");
    expect(JSON.stringify(action)).not.toMatch(/card|cvv|password|cookie/i);
  });

  it("refuses a command for a React-only interaction", async () => {
    const { store, internal } = await registered();
    expect(() => store.validateCommand({
      instanceId: "instance-1", ownerId: "owner-1", revision: 0,
      capabilityId: internal.capabilityId, promptTemplateId: null, kind: "select", arguments: {},
    })).toThrow(/internal interactions/);
  });

  it("refuses a forged prompt template, a stale revision, and an out-of-schema argument", async () => {
    const { store, external } = await registered();
    const base = { instanceId: "instance-1", ownerId: "owner-1", revision: 0, capabilityId: external.capabilityId, promptTemplateId: external.promptTemplateId, kind: "activate" };
    expect(() => store.validateCommand({ ...base, promptTemplateId: "tpl-forged", arguments: { selection: "record-3" } })).toThrow(/prompt template/);
    expect(() => store.validateCommand({ ...base, revision: 1, arguments: { selection: "record-3" } })).toThrow(/stale/);
    expect(() => store.validateCommand({ ...base, arguments: { selection: "record-3", cardNumber: "4111111111111111" } })).toThrow();
  });
});
