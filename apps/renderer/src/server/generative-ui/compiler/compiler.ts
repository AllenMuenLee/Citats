import ts from "typescript";
import { GENERATED_UI_RUNTIME_DTS } from "./runtime-dts";
import { RUNTIME_EXPORTS, validateGeneratedUiSource } from "./static-validator";
import type { CompiledModule, StaticValidationInput } from "./types";

export const GENERATED_UI_TOOLCHAIN_VERSION = `typescript-${ts.version}-gui-3`;

export class GeneratedUiCompilationError extends Error {
  constructor(
    readonly codes: readonly string[],
    /**
     * Optional, already-sanitized one-liners for the bounded repair turn.
     * Only ever the names TypeScript could not resolve in the model's own
     * generated source -- no free diagnostic text, no page content.
     */
    readonly details: readonly string[] = [],
  ) {
    super("Generated UI compilation rejected");
    this.name = "GeneratedUiCompilationError";
  }
}

/**
 * Compiles one validated generated view into the exact bytes the sandbox
 * executes (P04-F03 step 4).
 *
 * Compilation is local and hermetic: no package installation, no generated
 * plugin or script, no arbitrary path, no environment or file read, and no
 * source map. The lib is a hand-written ambient declaration rather than the
 * real TypeScript standard library precisely so the type checker cannot be
 * used to assert that some host API exists.
 *
 * The emit is deliberately *not* an ES module. The sandbox has no import
 * map and no network, so the module's single runtime import is rewritten
 * into a destructuring from the frozen runtime bridge, JSX is emitted
 * against that bridge's factory rather than `react/jsx-runtime`, and the
 * whole thing is wrapped in one IIFE that registers the component. That
 * keeps the sandbox's CSP at `default-src 'none'; script-src 'self'`.
 */
export function compileGeneratedUi(input: StaticValidationInput): CompiledModule {
  const validation = validateGeneratedUiSource(input);
  if (!validation.valid) throw new GeneratedUiCompilationError(validation.issues.map((issue) => issue.code));
  const typeErrors = typeCheckIsolated(input.source);
  if (typeErrors.length) {
    throw new GeneratedUiCompilationError(
      typeErrors.map((error) => error.code),
      typeErrors.map((error) => error.detail ?? ""),
    );
  }
  const result = ts.transpileModule(input.source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
      jsxFactory: "__rt.createElement",
      jsxFragmentFactory: "__rt.Fragment",
      sourceMap: false,
      inlineSourceMap: false,
      inlineSources: false,
      removeComments: true,
      verbatimModuleSyntax: false,
    },
    fileName: "generated-view.tsx",
    reportDiagnostics: true,
  });
  if (result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new GeneratedUiCompilationError(["TYPE_OR_TRANSPILE_ERROR"]);
  }
  // The sandbox destructure is built from the imports the source actually
  // declares, not from the manifest -- so a manifest that disagrees with
  // the code cannot break the bundle (the disagreement is a warning).
  const wrapped = wrapForSandbox(result.outputText, validation.imports);
  if (/sourceMappingURL|sourceURL/.test(wrapped)) throw new GeneratedUiCompilationError(["SOURCE_MAP_LEAKAGE"]);
  return { bytes: new TextEncoder().encode(wrapped), validation, toolchainVersion: GENERATED_UI_TOOLCHAIN_VERSION, sourceMapPolicy: "omitted" };
}

const RUNTIME_IMPORT = /^[ \t]*import\s*\{[^}]*\}\s*from\s*["']@ai-browser\/generated-ui-runtime["'][ \t]*;?[ \t]*$/gm;
const DEFAULT_EXPORT = /export\s+default\s+function\s+GeneratedView\b/;
const RESIDUAL_MODULE_SYNTAX = /(?:^|[\s;])(?:import|export)[\s({]/;

/**
 * Rewrites the emitted module into a classic script the sandbox can run.
 * Both substitutions are asserted rather than assumed: the static validator
 * has already guaranteed exactly one runtime import and exactly one
 * `export default function GeneratedView`, so a miss here means the emit
 * did not match what was validated, and that fails closed.
 */
function wrapForSandbox(emitted: string, runtimeImports: readonly string[]): string {
  RUNTIME_IMPORT.lastIndex = 0;
  const withoutImport = emitted.replace(RUNTIME_IMPORT, "");
  if (!DEFAULT_EXPORT.test(withoutImport)) throw new GeneratedUiCompilationError(["DEFAULT_EXPORT_REWRITE_FAILED"]);
  const body = withoutImport.replace(DEFAULT_EXPORT, "function GeneratedView");
  // Nothing that is still module syntax may survive into a classic script:
  // an unrewritten import or a second export means the emit did not match
  // what the validator approved, so this fails closed rather than shipping
  // a script the sandbox would evaluate differently than it was checked.
  if (RESIDUAL_MODULE_SYNTAX.test(body)) throw new GeneratedUiCompilationError(["RESIDUAL_MODULE_SYNTAX"]);
  const bound = runtimeImports.filter((name) => RUNTIME_EXPORTS.has(name));
  if (bound.length !== runtimeImports.length) throw new GeneratedUiCompilationError(["RUNTIME_EXPORT_NOT_ALLOWED"]);
  const destructure = bound.length > 0 ? `var { ${bound.join(", ")} } = __rt;` : "";
  return [
    '(function(){"use strict";',
    "var __bridge = globalThis.__generatedUiRuntime;",
    'if (!__bridge) { throw new Error("runtime unavailable"); }',
    "var __rt = __bridge.runtime;",
    destructure,
    body,
    "__bridge.register(GeneratedView);",
    "})();",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * The ambient lib the generated source is type-checked against. It is
 * intentionally minimal: no DOM, no Node, no `fetch`, no timers, no
 * `globalThis`. A generated view that references any of those fails to type
 * check here as well as failing the static validator, so the two gates
 * agree rather than one covering for the other.
 */
const AMBIENT = `
interface SymbolConstructor { readonly iterator: unique symbol }
declare var Symbol: SymbolConstructor;
/** The JSX factory the emit binds to. Declared so the isolated type check resolves JSX without pulling in React's types. */
declare const __rt: { readonly createElement: any; readonly Fragment: any };
interface Array<T> { readonly length: number; map<U>(callback: (value: T, index: number) => U): U[]; filter(callback: (value: T) => boolean): T[]; slice(start?: number, end?: number): T[]; concat(other: readonly T[]): T[]; indexOf(value: T): number; includes(value: T): boolean; join(separator?: string): string; find(callback: (value: T) => boolean): T | undefined; some(callback: (value: T) => boolean): boolean; every(callback: (value: T) => boolean): boolean; sort(compare?: (a: T, b: T) => number): T[]; reduce<U>(callback: (accumulator: U, value: T, index: number) => U, initial: U): U; readonly [index: number]: T; [Symbol.iterator](): { next(): { done: boolean; value: T } }; }
interface ReadonlyArray<T> extends Array<T> {}
interface String { readonly length: number; slice(start?: number, end?: number): string; toUpperCase(): string; toLowerCase(): string; trim(): string; includes(value: string): boolean; startsWith(value: string): boolean; split(separator: string): string[]; replace(from: string, to: string): string; localeCompare(other: string): number; }
interface Number { toFixed(digits?: number): string; toString(): string; }
interface Boolean {} interface Function {} interface Object {} interface RegExp {} interface IArguments {} interface CallableFunction {} interface NewableFunction {} interface Symbol {}
type Record<K extends string, T> = { readonly [P in K]: T }; type Readonly<T> = { readonly [P in keyof T]: T[P] }; type Partial<T> = { [P in keyof T]?: T[P] };
declare const Math: { max(...values: number[]): number; min(...values: number[]): number; round(value: number): number; abs(value: number): number; };
declare const JSON: { stringify(value: unknown): string };
declare namespace JSX { interface Element {} interface ElementChildrenAttribute { children: {} } interface IntrinsicElements { [name: string]: any } }
${GENERATED_UI_RUNTIME_DTS}
`;

interface IsolatedTypeError {
  readonly code: string;
  /** A sanitized one-liner naming the unresolved identifier, when the diagnostic is a "cannot find name". */
  readonly detail?: string;
}

/**
 * Pulls only the quoted identifier out of a "Cannot find name 'X'" / "did
 * you mean 'Y'" diagnostic and rebuilds a fixed sentence from it. The
 * diagnostic's own message text is never forwarded -- an identifier matched
 * by this pattern is at most 40 word-characters and cannot carry page
 * content or an instruction.
 */
function nameResolutionDetail(diagnostic: ts.Diagnostic): string | undefined {
  if (diagnostic.code !== 2304 && diagnostic.code !== 2552 && diagnostic.code !== 2551) return undefined;
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const names = [...text.matchAll(/'([A-Za-z_$][\w$]{0,40})'/g)].map((match) => match[1]);
  if (names.length === 0) return undefined;
  return `Unresolved name ${names[0]}${names[1] ? ` (did you mean ${names[1]}?)` : ""} -- import it from "@ai-browser/generated-ui-runtime" or declare it before use.`;
}

function typeCheckIsolated(source: string): IsolatedTypeError[] {
  const files = new Map([
    ["/generated-view.tsx", source],
    ["/ambient.d.ts", AMBIENT],
  ]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.React,
    jsxFactory: "__rt.createElement",
    jsxFragmentFactory: "__rt.Fragment",
    strict: true,
    noEmit: true,
    noLib: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name),
    getSourceFile: (name, languageVersion) => {
      const text = files.get(name);
      return text === undefined
        ? undefined
        : ts.createSourceFile(name, text, languageVersion, true, name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/none.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([...files.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const detail = nameResolutionDetail(diagnostic);
    return { code: `TYPE_CHECK_${diagnostic.code}`, ...(detail ? { detail } : {}) };
  });
}
