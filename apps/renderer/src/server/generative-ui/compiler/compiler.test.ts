import { describe, expect, it } from "vitest";
import type { GeneratedUiArtifactManifest } from "@ai-browser/contracts";
import { compileGeneratedUi, GeneratedUiCompilationError } from "./compiler";
import { validateGeneratedUiSource } from "./static-validator";

const limits = { maxSourceBytes: 65_536, maxAstNodes: 20_000, maxComplexity: 200, maxRenderNodes: 5_000, maxLocalStateEntries: 32 };
const manifest: GeneratedUiArtifactManifest = {
  observationIds: ["obs-1"], sourceIds: ["source-1"], recordIds: [], mediaIds: [], capabilityIds: ["cap-1"], emittedCommandKinds: ["activate"], localInteractions: [],
  accessibilityFeatures: ["heading_order", "keyboard"], responsiveRegions: ["main"], runtimeImports: ["GeneratedViewProps", "Card", "Heading", "Source", "CommandButton"], fallback: false,
};
const valid = `import { type GeneratedViewProps, Card, Heading, Source, CommandButton } from "@ai-browser/generated-ui-runtime";
export default function GeneratedView(props: GeneratedViewProps) {
 const source = props.getSource("source-1");
 return <Card aria-label="Results"><Heading>Results</Heading>{source ? <Source source={source} /> : null}<CommandButton runtime={props} capabilityId="cap-1" kind="activate">Open</CommandButton></Card>;
}`;

describe("generated UI compiler", () => {
  it("accepts an allowlisted component and emits no source map", () => {
    const result = compileGeneratedUi({ source: valid, manifest, limits, allowedTokens: ["surface"] });
    expect(new TextDecoder().decode(result.bytes)).not.toContain("sourceMappingURL");
    expect(result.validation.valid).toBe(true);
  });

  it.each([
    ["network", `fetch("https://evil.test")`, "FORBIDDEN_GLOBAL"],
    ["obfuscated global", `globalThis["fetch"]("x")`, "FORBIDDEN_GLOBAL"],
    ["constructor escape", `({}).constructor`, "PROTOTYPE_ESCAPE"],
    ["dynamic property", `props["x" + "y"]`, "DYNAMIC_PROPERTY_ACCESS"],
    ["storage", `localStorage.getItem("x")`, "FORBIDDEN_GLOBAL"],
    ["timer", `setInterval(() => {}, 1)`, "FORBIDDEN_GLOBAL"],
    ["worker", `new Worker("x")`, "FORBIDDEN_GLOBAL"],
    ["dangerous html", `<div dangerouslySetInnerHTML={{__html:"x"}} />`, "DANGEROUS_JSX_ATTRIBUTE"],
    ["iframe", `<iframe src="x" />`, "FORBIDDEN_JSX_ELEMENT"],
    ["ref abuse", `<div ref={() => undefined} />`, "DANGEROUS_JSX_ATTRIBUTE"],
    ["loop", `while (true) {}`, "LOOP_NOT_ALLOWED"],
    ["memory bomb", `"x".repeat(999999)`, "MEMORY_LIMIT_EXCEEDED"],
    ["CSS exfiltration", `<div style={{background:"url(https://evil.test)"}} />`, "RAW_STYLE_ESCAPE"],
    ["dynamic import", `import("evil")`, "DYNAMIC_IMPORT"],
  ])("rejects %s", (_name, payload, code) => {
    const source = valid.replace(" const source =", ` ${payload}; const source =`);
    expect(validateGeneratedUiSource({ source, manifest, limits, allowedTokens: [] }).issues.map((item) => item.code)).toContain(code);
  });

  it("rejects command forgery and manifest disagreement", () => {
    const source = valid.replace('capabilityId="cap-1"', 'capabilityId="forged"');
    expect(validateGeneratedUiSource({ source, manifest, limits, allowedTokens: [] }).issues.map((item) => item.code)).toContain("MANIFEST_CAPABILITY_IDS_MISMATCH");
  });

  it("fails closed before compilation", () => {
    expect(() => compileGeneratedUi({ source: valid.replace("<Card", "<iframe"), manifest, limits, allowedTokens: [] })).toThrow(GeneratedUiCompilationError);
  });
});
