import ts from "typescript";
import { RUNTIME_EXPORTS, validateGeneratedUiSource } from "./static-validator";
import type { CompiledModule, StaticValidationInput } from "./types";

export const GENERATED_UI_TOOLCHAIN_VERSION = `typescript-${ts.version}-gui-2`;

export class GeneratedUiCompilationError extends Error {
  constructor(readonly codes: readonly string[]) {
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
  if (typeErrors.length) throw new GeneratedUiCompilationError(typeErrors);
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
  const wrapped = wrapForSandbox(result.outputText, input.manifest.runtimeImports);
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
declare module "@ai-browser/generated-ui-runtime" {
  export type OpaqueId = string;
  export interface DisplaySource { readonly id: OpaqueId; readonly title: string; readonly origin: string; readonly finalUrl: string; readonly retrievedAt: string; readonly captureStatus: "complete" | "truncated" | "partial"; }
  export interface DisplayFact { readonly id: OpaqueId; readonly label: string; readonly value: string; readonly kind: string; readonly unit: string | null; readonly numericValue: number | null; readonly sourceId: OpaqueId; readonly note: string | null; }
  export interface DisplayRecordField { readonly id: OpaqueId; readonly label: string; readonly value: string; readonly role: string; readonly numericValue: number | null; }
  export interface DisplayRecord { readonly id: OpaqueId; readonly collectionId: OpaqueId; readonly title: string; readonly sourceId: OpaqueId; readonly fields: readonly DisplayRecordField[]; readonly mediaIds: readonly OpaqueId[]; readonly factIds: readonly OpaqueId[]; }
  export interface DisplayCollection { readonly id: OpaqueId; readonly label: string; readonly description: string; readonly comparableFieldRoles: readonly string[]; }
  export interface DisplayMedia { readonly id: OpaqueId; readonly kind: "image" | "illustration" | "chart" | "video" | "audio" | "icon"; readonly alternativeText: string; readonly caption: string | null; readonly sourceId: OpaqueId; }
  export interface DisplayCoverage { readonly requestedSources: number; readonly capturedSources: number; readonly omissions: readonly string[]; readonly unsupportedRequests: readonly string[]; readonly confidence: "high" | "medium" | "low"; }
  export interface GeneratedViewProps {
    readonly instanceRevision: number; readonly goal: string;
    readonly sources: readonly DisplaySource[]; readonly collections: readonly DisplayCollection[];
    readonly records: readonly DisplayRecord[]; readonly facts: readonly DisplayFact[];
    readonly media: readonly DisplayMedia[]; readonly coverage: DisplayCoverage;
    getSource(id: OpaqueId): DisplaySource | undefined; getCollection(id: OpaqueId): DisplayCollection | undefined;
    getRecord(id: OpaqueId): DisplayRecord | undefined; getFact(id: OpaqueId): DisplayFact | undefined;
    getMedia(id: OpaqueId): DisplayMedia | undefined;
  }
  export const semanticTokens: Readonly<Record<string, string>>;
  export const Stack: any, Inline: any, Grid: any, Card: any, Region: any, Text: any, Heading: any, Badge: any, List: any, ListItem: any, Table: any, TableHead: any, TableBody: any, TableRow: any, TableHeader: any, TableCell: any, Label: any, Select: any, Option: any, Status: any, Warning: any, Source: any, Freshness: any, Icon: any, Media: any, Modal: any;
  export function useBoundedState<T>(initial: T, allowed: readonly T[]): readonly [T, (next: T) => void];
  export function useLocalCollection<T>(items: readonly T[], options: { readonly filter?: (item: T) => boolean; readonly compare?: (a: T, b: T) => number }): readonly T[];
  export function formatNumber(value: number, locale?: string): string;
  export function formatCurrency(value: number, currency: string, locale?: string): string;
  export function formatDate(value: string, locale?: string): string;
  export const createElement: any; export const Fragment: any;
}
`;

function typeCheckIsolated(source: string): string[] {
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
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => `TYPE_CHECK_${diagnostic.code}`);
}
