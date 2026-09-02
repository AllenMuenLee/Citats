import { describe, expect, it } from "vitest";
import type { GeneratedUiArtifactManifest } from "@ai-browser/contracts";
import { compileGeneratedUi, GeneratedUiCompilationError } from "./compiler";
import { validateGeneratedUiSource } from "./static-validator";

const limits = { maxSourceBytes: 65_536, maxAstNodes: 20_000, maxComplexity: 200, maxRenderNodes: 5_000, maxLocalStateEntries: 24 };
const allowedTokens = ["surface", "accent", "text-primary", "border"];

const manifest: GeneratedUiArtifactManifest = {
  planDigest: "a".repeat(64),
  sourceIds: ["src-1"],
  recordIds: ["rec-1"],
  factIds: [],
  mediaIds: [],
  componentIds: ["root", "table"],
  localInteractions: [{ stateKey: "sortBy", kind: "sort", boundedValues: 2 }],
  accessibilityFeatures: ["heading_order", "keyboard"],
  responsiveRegions: ["main"],
  runtimeImports: ["GeneratedViewProps", "Region", "Heading", "Source", "Text", "useBoundedState"],
  fallback: false,
};

const valid = `import { type GeneratedViewProps, Region, Heading, Source, Text, useBoundedState } from "@ai-browser/generated-ui-runtime";
export default function GeneratedView(props: GeneratedViewProps) {
 const source = props.getSource("src-1");
 const record = props.getRecord("rec-1");
 const [sortBy, setSortBy] = useBoundedState("price", ["price", "rating"]);
 return <Region componentId="root" label="Results">
  <Heading level={1}>Results</Heading>
  <Region componentId="table" label="Comparison">
   <Text>{record ? record.title : ""}</Text>
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
    // The sandbox runs a classic script, not an ES module: the runtime
    // import is bound from the frozen bridge and the default export is gone.
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
    ["loop", `while (true) {}`, "LOOP_NOT_ALLOWED"],
    ["construction", `new Date()`, "CONSTRUCTION_NOT_ALLOWED"],
    ["memory bomb", `"x".repeat(999999)`, "MEMORY_LIMIT_EXCEEDED"],
    ["CSS exfiltration", `<div style={{background:"url(https://evil.test)"}} />`, "RAW_STYLE_ESCAPE"],
    ["raw colour", `<div style={{color:"#ff0000"}} />`, "RAW_STYLE_ESCAPE"],
    ["dynamic import", `import("evil")`, "DYNAMIC_IMPORT"],
    ["absolute URL literal", `const u = "https://evil.test/x";`, "EXECUTABLE_OR_EXTERNAL_URL"],
    ["data URL literal", `const u = "data:text/html,x";`, "EXECUTABLE_OR_EXTERNAL_URL"],
  ])("rejects %s", (_name, payload, code) => {
    const source = valid.replace(" const source =", ` ${payload}; const source =`);
    expect(validateGeneratedUiSource({ source, manifest, limits, allowedTokens }).issues.map((item) => item.code)).toContain(code);
  });

  it("rejects a forged plan reference and the manifest disagreement it causes", () => {
    const source = valid.replace('getRecord("rec-1")', 'getRecord("rec-forged")');
    expect(validateGeneratedUiSource({ source, manifest, limits, allowedTokens }).issues.map((item) => item.code)).toContain("MANIFEST_RECORD_IDS_MISMATCH");
  });

  it("rejects a component id the plan never declared", () => {
    const source = valid.replace('componentId="table"', 'componentId="ghost"');
    expect(validateGeneratedUiSource({ source, manifest, limits, allowedTokens }).issues.map((item) => item.code)).toContain("MANIFEST_COMPONENT_IDS_MISMATCH");
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

  it("fails closed before compilation", () => {
    expect(() => compileGeneratedUi({ source: valid.replace("<Heading level={1}>Results</Heading>", "<iframe />"), manifest, limits, allowedTokens })).toThrow(
      GeneratedUiCompilationError,
    );
  });
});
