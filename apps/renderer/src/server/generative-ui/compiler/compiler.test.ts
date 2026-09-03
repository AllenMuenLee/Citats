import { describe, expect, it } from "vitest";
import type { GeneratedUiArtifactManifest } from "@ai-browser/contracts";
import { compileGeneratedUi, GeneratedUiCompilationError } from "./compiler";
import { validateGeneratedUiSource } from "./static-validator";

const limits = { maxSourceBytes: 65_536, maxAstNodes: 20_000, maxComplexity: 200, maxRenderNodes: 5_000, maxLocalStateEntries: 24 };
const allowedTokens = ["surface", "accent", "text-primary", "border"];

const manifest: GeneratedUiArtifactManifest = {
  sourceIds: ["src-1"],
  localInteractions: [{ stateKey: "sortBy", kind: "sort", boundedValues: 2 }],
  accessibilityFeatures: ["heading_order", "keyboard"],
  responsiveRegions: ["Results", "Comparison"],
  runtimeImports: ["GeneratedViewProps", "Region", "Heading", "Source", "Text", "useBoundedState"],
  fallback: false,
};

const valid = `import { type GeneratedViewProps, Region, Heading, Source, Text, useBoundedState } from "@ai-browser/generated-ui-runtime";
export default function GeneratedView(props: GeneratedViewProps) {
 const source = props.getSource("src-1");
 const [sortBy, setSortBy] = useBoundedState("price", ["price", "rating"]);
 return <Region label="Results">
  <Heading level={1}>Results</Heading>
  <Region label="Comparison">
   <Text>Grinder One: 199</Text>
   <button type="button" onClick={() => setSortBy("rating")}>{sortBy}</button>
  </Region>
  {source ? <Source source={source} /> : null}
 </Region>;
}`;

describe("generated UI compiler", () => {
  it("accepts an allowlisted component, emits no source map, and emits no module syntax", () => {
    const result = compileGeneratedUi({ source: valid, manifest, limits, allowedTokens });
    const emitted = new TextDecoder().decode(result.bytes);
    expect(result.validation.valid).toBe(true);
    expect(emitted).not.toContain("sourceMappingURL");
    expect(emitted).not.toMatch(/(?:^|[\s;])(?:import|export)[\s({]/);
    expect(emitted).toContain("__bridge.register(GeneratedView)");
    expect(emitted).toContain("var { GeneratedViewProps, Region, Heading, Source, Text, useBoundedState } = __rt;");
  });

  it.each([
    ["network", `fetch("https://evil.test")`, "FORBIDDEN_GLOBAL"],
    ["obfuscated global", `globalThis["fetch"]("x")`, "FORBIDDEN_GLOBAL"],
    ["constructor escape", `({}).constructor`, "PROTOTYPE_ESCAPE"],
    ["dynamic property", `props["x" + "y"]`, "DYNAMIC_PROPERTY_ACCESS"],
    ["storage", `localStorage.getItem("x")`, "FORBIDDEN_GLOBAL"],
    ["cookies", `document.cookie`, "FORBIDDEN_GLOBAL"],
    ["navigation", `location.href`, "FORBIDDEN_GLOBAL"],
    ["postMessage", `postMessage("x")`, "FORBIDDEN_GLOBAL"],
    ["timer", `setInterval(() => {}, 1)`, "FORBIDDEN_GLOBAL"],
    ["worker", `new Worker("x")`, "FORBIDDEN_GLOBAL"],
    ["process", `process.env`, "FORBIDDEN_GLOBAL"],
    ["eval", `eval("x")`, "FORBIDDEN_GLOBAL"],
    ["unsafe hook", `useEffect(() => {}, [])`, "UNBOUNDED_OR_UNSAFE_HOOK"],
    ["dangerous html", `<div dangerouslySetInnerHTML={{__html:"x"}} />`, "DANGEROUS_JSX_ATTRIBUTE"],
    ["iframe", `<iframe src="x" />`, "FORBIDDEN_JSX_ELEMENT"],
    ["anchor", `<a href="https://evil.test">x</a>`, "FORBIDDEN_JSX_ELEMENT"],
    ["image", `<img src="https://evil.test/x.png" />`, "FORBIDDEN_JSX_ELEMENT"],
    ["form", `<form><span>x</span></form>`, "FORBIDDEN_JSX_ELEMENT"],
    ["ref abuse", `<div ref={() => undefined} />`, "DANGEROUS_JSX_ATTRIBUTE"],
    ["spread props", `<div {...props} />`, "JSX_SPREAD_NOT_ALLOWED"],
    ["loop", `while (true) {}`, "LOOP_NOT_ALLOWED"],
    ["construction", `new Date()`, "CONSTRUCTION_NOT_ALLOWED"],
    ["memory bomb", `"x".repeat(999999)`, "MEMORY_LIMIT_EXCEEDED"],
    ["CSS exfiltration", `<div style={{background:"url(https://evil.test)"}} />`, "CSS_EXFILTRATION"],
    ["dynamic import", `import("evil")`, "DYNAMIC_IMPORT"],
    ["absolute URL literal", `const u = "https://evil.test/x";`, "EXECUTABLE_OR_EXTERNAL_URL"],
    ["data URL literal", `const u = "data:text/html,x";`, "EXECUTABLE_OR_EXTERNAL_URL"],
  ])("rejects %s", (_name, payload, code) => {
    const source = valid.replace(" const source =", ` ${payload}; const source =`);
    expect(validateGeneratedUiSource({ source, manifest, limits, allowedTokens }).issues.map((item) => item.code)).toContain(code);
  });

  it("flags a forged source reference and manifest drift as non-blocking warnings", () => {
    const source = valid.replace('getSource("src-1")', 'getSource("src-forged")');
    const result = validateGeneratedUiSource({ source, manifest, limits, allowedTokens });
    expect(result.issues.map((item) => item.code)).toContain("MANIFEST_SOURCE_IDS_MISMATCH");
    expect(result.issues.find((item) => item.code === "MANIFEST_SOURCE_IDS_MISMATCH")?.severity).toBe("warning");
    expect(result.valid).toBe(true);
  });

  it("treats a raw colour as a warning but still compiles the view", () => {
    const withColour = valid.replace("<Text>Grinder One: 199</Text>", '<Text style={{ color: "#ff0000" }}>Grinder One: 199</Text>');
    const result = validateGeneratedUiSource({ source: withColour, manifest, limits, allowedTokens });
    expect(result.issues.map((item) => item.code)).toContain("RAW_COLOR_VALUE");
    expect(result.valid).toBe(true);
    expect(() => compileGeneratedUi({ source: withColour, manifest, limits, allowedTokens })).not.toThrow();
  });

  it("still rejects a functional CSS value outright", () => {
    const withUrl = valid.replace("<Text>Grinder One: 199</Text>", '<Text style={{ background: "url(https://evil.test)" }}>x</Text>');
    const result = validateGeneratedUiSource({ source: withUrl, manifest, limits, allowedTokens });
    expect(result.issues.map((item) => item.code)).toContain("CSS_EXFILTRATION");
    expect(result.valid).toBe(false);
  });

  it("warns on a manifest responsive region the source never renders", () => {
    const drifted: GeneratedUiArtifactManifest = { ...manifest, responsiveRegions: ["Results", "Ghost"] };
    const result = validateGeneratedUiSource({ source: valid, manifest: drifted, limits, allowedTokens });
    expect(result.issues.map((item) => item.code)).toContain("MANIFEST_RESPONSIVE_REGIONS_MISMATCH");
    expect(result.valid).toBe(true);
  });

  it("rejects an import from anywhere but the runtime module", () => {
    const source = `import { useState } from "react";\n${valid}`;
    const codes = validateGeneratedUiSource({ source, manifest, limits, allowedTokens }).issues.map((item) => item.code);
    expect(codes).toContain("IMPORT_NOT_ALLOWED");
  });

  it("rejects a theme token the theme does not publish", () => {
    const source = valid.replace("<Heading level={1}>", '<Heading level={1} style={{ color: semanticTokens.brandPink }}>');
    const withImport = source.replace("Region, Heading", "Region, Heading, semanticTokens");
    expect(validateGeneratedUiSource({ source: withImport, manifest, limits, allowedTokens }).issues.map((item) => item.code)).toContain("THEME_TOKEN_NOT_ALLOWED");
  });

  it("rejects more local state than the limits allow", () => {
    const extra = valid.replace(
      " return <Region",
      ' const [b, setB] = useBoundedState("a", ["a"]);\n return <Region',
    );
    const codes = validateGeneratedUiSource({ source: extra, manifest, limits: { ...limits, maxLocalStateEntries: 1 }, allowedTokens }).issues.map((item) => item.code);
    expect(codes).toContain("LOCAL_STATE_LIMIT_EXCEEDED");
  });

  it("enforces render-node limits", () => {
    const codes = validateGeneratedUiSource({ source: valid, manifest, limits: { ...limits, maxRenderNodes: 2 }, allowedTokens }).issues.map((item) => item.code);
    expect(codes).toContain("RENDER_NODE_LIMIT_EXCEEDED");
  });

  it("requires stable keys for JSX emitted from array maps", () => {
    const mapped = valid.replace(
      " return <Region",
      ' const rows = props.sources.map((item) => <Text>{item.title}</Text>);\n return <Region',
    );
    const codes = validateGeneratedUiSource({ source: mapped, manifest, limits, allowedTokens }).issues.map((item) => item.code);
    expect(codes).toContain("STABLE_KEY_REQUIRED");
  });

  it("fails closed before compilation", () => {
    expect(() => compileGeneratedUi({ source: valid.replace("<Heading level={1}>Results</Heading>", "<iframe />"), manifest, limits, allowedTokens })).toThrow(
      GeneratedUiCompilationError,
    );
  });
});
