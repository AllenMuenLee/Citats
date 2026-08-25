import ts from "typescript";
import { validateGeneratedUiSource } from "./static-validator";
import type { CompiledModule, StaticValidationInput } from "./types";

export const GENERATED_UI_TOOLCHAIN_VERSION = `typescript-${ts.version}-gui-1`;

export class GeneratedUiCompilationError extends Error {
  constructor(readonly codes: readonly string[]) { super("Generated UI compilation rejected"); this.name = "GeneratedUiCompilationError"; }
}

export function compileGeneratedUi(input: StaticValidationInput): CompiledModule {
  const validation = validateGeneratedUiSource(input);
  if (!validation.valid) throw new GeneratedUiCompilationError(validation.issues.map((issue) => issue.code));
  const typeErrors = typeCheckIsolated(input.source);
  if (typeErrors.length) throw new GeneratedUiCompilationError(typeErrors);
  const result = ts.transpileModule(input.source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      sourceMap: false,
      inlineSourceMap: false,
      inlineSources: false,
      removeComments: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName: "generated-view.tsx",
    reportDiagnostics: true,
  });
  if (result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) throw new GeneratedUiCompilationError(["TYPE_OR_TRANSPILE_ERROR"]);
  if (/sourceMappingURL|sourceURL/.test(result.outputText)) throw new GeneratedUiCompilationError(["SOURCE_MAP_LEAKAGE"]);
  return { bytes: new TextEncoder().encode(result.outputText), validation, toolchainVersion: GENERATED_UI_TOOLCHAIN_VERSION, sourceMapPolicy: "omitted" };
}

const AMBIENT = `
interface Array<T> { readonly length: number; map<U>(callback: (value: T, index: number) => U): U[]; filter(callback: (value: T) => boolean): T[]; }
interface ReadonlyArray<T> extends Array<T> {}
interface Function {} interface Object {} interface String {} interface Number {} interface Boolean {} interface RegExp {} interface IArguments {} interface CallableFunction {} interface NewableFunction {}
type Record<K extends string, T> = { readonly [P in K]: T }; type Readonly<T> = { readonly [P in keyof T]: T[P] };
declare namespace JSX { interface Element {} interface IntrinsicElements { [name: string]: any } }
declare module "react/jsx-runtime" { export const jsx: any; export const jsxs: any; export const Fragment: any; }
declare module "@ai-browser/generated-ui-runtime" {
  export interface GeneratedViewProps { readonly instanceRevision: number; readonly records: readonly unknown[]; readonly sources: readonly unknown[]; readonly media: readonly unknown[]; readonly capabilities: readonly unknown[]; getRecord(id: OpaqueId): unknown; getSource(id: OpaqueId): unknown; getMedia(id: OpaqueId): unknown; getCapability(id: OpaqueId): unknown; }
  export type OpaqueId = string; export type CommandKind = "activate" | "select" | "set_value" | "open_detail" | "media_control";
  export const semanticTokens: Readonly<Record<string,string>>;
  export const Stack: any, Inline: any, Grid: any, Card: any, Text: any, Heading: any, Badge: any, List: any, ListItem: any, Table: any, TableHead: any, TableBody: any, TableRow: any, TableHeader: any, TableCell: any, Label: any, Select: any, Option: any, Status: any, Warning: any, Source: any, Freshness: any, Icon: any, Media: any, Modal: any, CommandButton: any;
  export function useBoundedState<T>(initial: T, allowed: readonly T[]): readonly [T, (next: T) => void];
  export function formatNumber(value: number, locale?: string): string; export function formatCurrency(value: number, currency: string, locale?: string): string; export function formatDate(value: string, locale?: string): string; export const createElement: any;
}
`;

function typeCheckIsolated(source: string): string[] {
  const files = new Map([["/generated-view.tsx", source], ["/ambient.d.ts", AMBIENT]]);
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, strict: true, noEmit: true, noLib: true, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const host: ts.CompilerHost = {
    fileExists: (name) => files.has(name), readFile: (name) => files.get(name),
    getSourceFile: (name, languageVersion) => { const text = files.get(name); return text === undefined ? undefined : ts.createSourceFile(name, text, languageVersion, true, name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS); },
    getDefaultLibFileName: () => "/none.d.ts", writeFile: () => undefined, getCurrentDirectory: () => "/", getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  };
  const program = ts.createProgram([...files.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => `TYPE_CHECK_${diagnostic.code}`);
}
