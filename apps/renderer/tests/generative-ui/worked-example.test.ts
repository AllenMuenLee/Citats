import { describe, expect, it } from "vitest";
import {
  UiGenerationResponseSchema,
  type GeneratedUiArtifactManifest,
} from "@ai-browser/contracts";
import { UI_GENERATION_SYSTEM_PROMPT } from "../../src/server/generative-ui/system-prompt";
import {
  GENERATED_UI_ALLOWED_TOKENS,
  GENERATED_UI_LIMITS,
} from "../../src/server/generative-ui/request-builder";
import { compileGeneratedUi } from "../../src/server/generative-ui/compiler";

/**
 * The system prompt hands `UI_MODEL` a worked example to copy. If that
 * example does not itself pass the real validator, type-check, and compile,
 * the instruction is actively harmful -- so it is pinned here.
 */
describe("UI generation worked example", () => {
  const marker = "WORKED EXAMPLE";
  const start = UI_GENERATION_SYSTEM_PROMPT.indexOf("{", UI_GENERATION_SYSTEM_PROMPT.indexOf(marker));
  const json = UI_GENERATION_SYSTEM_PROMPT.slice(start);

  it("is a single response envelope with the required keys", () => {
    // The server overwrites the identity fields before validation, so the raw
    // example carries them as empty strings on purpose; fill them the way the
    // adapter does, then assert the closed contract accepts the shape.
    const raw = JSON.parse(json) as Record<string, unknown>;
    const parsed = UiGenerationResponseSchema.parse({
      ...raw,
      modelIdentifier: "m",
      promptDigest: "a".repeat(64),
      inputDigest: "b".repeat(64),
      runtimeVersion: "3.0.0",
      toolchainVersion: "typescript-5-gui-3",
    });
    expect(parsed.tsxSource).toBeTruthy();
    expect(parsed.fallbackReason).toBeNull();
  });

  it("compiles through the real gate", () => {
    const response = JSON.parse(json) as {
      tsxSource: string;
      manifest: GeneratedUiArtifactManifest;
    };
    const compiled = compileGeneratedUi({
      source: response.tsxSource,
      manifest: response.manifest,
      limits: { ...GENERATED_UI_LIMITS },
      allowedTokens: [...GENERATED_UI_ALLOWED_TOKENS],
    });
    expect(compiled.validation.valid).toBe(true);
    expect(compiled.bytes.length).toBeGreaterThan(0);
  });
});
