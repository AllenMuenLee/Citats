import ts from "typescript";
import type { StaticValidationInput, StaticValidationIssue, StaticValidationResult } from "./types";

const RUNTIME_MODULE = "@ai-browser/generated-ui-runtime";
const RUNTIME_EXPORTS = new Set(["GeneratedViewProps", "OpaqueId", "CommandKind", "CommandArgument", "CommandArguments", "UiCommand", "DisplayRecord", "DisplaySource", "DisplayMedia", "DisplayCapability", "semanticTokens", "Stack", "Inline", "Grid", "Card", "Text", "Heading", "Badge", "List", "ListItem", "Table", "TableHead", "TableBody", "TableRow", "TableHeader", "TableCell", "Label", "Select", "Option", "Status", "Warning", "Source", "Freshness", "Icon", "Media", "Modal", "CommandButton", "useBoundedState", "useLocalCollection", "formatNumber", "formatCurrency", "formatDate", "createElement"]);
const FORBIDDEN_IDENTIFIERS = new Set([
  "window", "document", "globalThis", "self", "top", "parent", "frames", "navigator", "location", "history",
  "localStorage", "sessionStorage", "indexedDB", "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
  "process", "require", "module", "Buffer", "Deno", "Bun", "electron", "eval", "Function", "Worker",
  "SharedWorker", "setTimeout", "setInterval", "requestAnimationFrame", "queueMicrotask", "MutationObserver",
]);
const FORBIDDEN_PROPERTIES = new Set(["constructor", "prototype", "__proto__", "caller", "callee", "arguments"]);
const FORBIDDEN_JSX = new Set(["iframe", "webview", "script", "style", "object", "embed", "form", "portal"]);
const ALLOWED_INTRINSICS = new Set(["div", "span", "section", "article", "main", "header", "footer", "nav", "p", "strong", "em", "small", "ol", "ul", "li", "h1", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "th", "td", "button"]);
type ReferenceKey = "sourceIds" | "recordIds" | "mediaIds" | "capabilityIds";
const ID_LOOKUPS: Readonly<Record<string, ReferenceKey>> = {
  getSource: "sourceIds", getRecord: "recordIds", getMedia: "mediaIds", getCapability: "capabilityIds",
};

export function validateGeneratedUiSource(input: StaticValidationInput): StaticValidationResult {
  const sourceFile = ts.createSourceFile("generated-view.tsx", input.source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const issues: StaticValidationIssue[] = [];
  let astNodes = 0;
  let complexity = 1;
  let maximumDepth = 0;
  let defaultExports = 0;
  let generatedViewDeclarations = 0;
  const imports = new Set<string>();
  const references = { sourceIds: new Set<string>(), recordIds: new Set<string>(), mediaIds: new Set<string>(), capabilityIds: new Set<string>(), emittedCommandKinds: new Set<string>() };

  const add = (code: string, node?: ts.Node) => {
    const position = node ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false)) : null;
    issues.push({ code, severity: "error", location: position ? { line: position.line + 1, column: position.character } : null });
  };
  const literalArgument = (call: ts.CallExpression, index: number) => {
    const arg = call.arguments[index];
    return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
  };
  const visit = (node: ts.Node, depth: number): void => {
    astNodes += 1;
    maximumDepth = Math.max(maximumDepth, depth);
    if (astNodes > input.limits.maxAstNodes) return;
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== RUNTIME_MODULE) add("IMPORT_NOT_ALLOWED", node);
      if (!node.importClause || node.importClause.name || node.importClause.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) add("IMPORT_SHAPE_NOT_ALLOWED", node);
      if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) for (const item of node.importClause.namedBindings.elements) { imports.add(item.name.text); if (!RUNTIME_EXPORTS.has(item.propertyName?.text ?? item.name.text)) add("RUNTIME_EXPORT_NOT_ALLOWED", item); }
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) defaultExports += 1;
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === "GeneratedView") {
      generatedViewDeclarations += 1;
      const modifiers = ts.getModifiers(node) ?? [];
      if (!modifiers.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword) || !modifiers.some((item) => item.kind === ts.SyntaxKind.ExportKeyword)) add("DEFAULT_EXPORT_REQUIRED", node);
      if (ts.isFunctionDeclaration(node)) {
        const parameter = node.parameters[0];
        if (node.parameters.length !== 1 || !parameter?.type || parameter.type.getText(sourceFile) !== "GeneratedViewProps") add("INVALID_VIEW_PROPS", node);
      }
    }
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text) && !isDeclarationName(node)) add("FORBIDDEN_GLOBAL", node);
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_PROPERTIES.has(node.name.text)) add("PROTOTYPE_ESCAPE", node);
    if (ts.isElementAccessExpression(node) && (!node.argumentExpression || !ts.isStringLiteralLike(node.argumentExpression))) add("DYNAMIC_PROPERTY_ACCESS", node);
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) && FORBIDDEN_PROPERTIES.has(node.argumentExpression.text)) add("PROTOTYPE_ESCAPE", node);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add("DYNAMIC_IMPORT", node);
      if (ts.isIdentifier(node.expression) && (node.expression.text === "useState" || node.expression.text === "useEffect" || node.expression.text === "useLayoutEffect" || node.expression.text === "useRef")) add("UNBOUNDED_OR_UNSAFE_HOOK", node);
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const key = ID_LOOKUPS[method];
        if (key) { const value = literalArgument(node, 0); if (value) references[key].add(value); else add("DYNAMIC_REFERENCE_ID", node); }
      }
    }
    if (ts.isNewExpression(node)) add("CONSTRUCTION_NOT_ALLOWED", node);
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 1_000) add("MEMORY_LIMIT_EXCEEDED", node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "repeat") add("MEMORY_LIMIT_EXCEEDED", node);
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) add("LOOP_NOT_ALLOWED", node);
    if (ts.isConditionalExpression(node) || ts.isIfStatement(node) || ts.isCaseClause(node) || ts.isCatchClause(node) || ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) complexity += 1;
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (name === "dangerouslySetInnerHTML" || name === "ref" || name === "autoFocus") add("DANGEROUS_JSX_ATTRIBUTE", node);
      if (/^on[A-Z]/.test(name) && node.initializer && !ts.isJsxExpression(node.initializer)) add("INLINE_EVENT_LEAKAGE", node);
      if ((name === "href" || name === "src" || name === "action" || name === "formAction") && node.initializer && ts.isStringLiteral(node.initializer)) add("EXTERNAL_ASSET_LITERAL", node);
      if (name === "style" && node.initializer && /(?:#[0-9a-f]{3,8}|rgb\(|hsl\(|url\(|expression\()/i.test(node.initializer.getText(sourceFile))) add("RAW_STYLE_ESCAPE", node);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      if (FORBIDDEN_JSX.has(tag)) add("FORBIDDEN_JSX_ELEMENT", node);
      if (/^[a-z]/.test(tag) && !ALLOWED_INTRINSICS.has(tag)) add("INTRINSIC_NOT_ALLOWED", node);
      if (tag === "img") add("USE_SAFE_MEDIA_COMPONENT", node);
      if (tag === "button" && !hasJsxAttribute(node, "type")) add("BUTTON_TYPE_REQUIRED", node);
      if (tag === "CommandButton") {
        const capability = jsxStringAttribute(node, "capabilityId");
        const kind = jsxStringAttribute(node, "kind");
        if (capability) references.capabilityIds.add(capability); else add("DYNAMIC_REFERENCE_ID", node);
        if (kind) references.emittedCommandKinds.add(kind); else add("DYNAMIC_COMMAND_KIND", node);
      }
    }
    if (ts.isStringLiteralLike(node) && /(?:javascript:|data:text\/html|https?:\/\/)/i.test(node.text)) add("EXECUTABLE_OR_EXTERNAL_URL", node);
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(sourceFile, 1);
  if ((sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) add("SYNTAX_ERROR");
  if (generatedViewDeclarations !== 1 || defaultExports !== 0) {
    if (generatedViewDeclarations !== 1) add("EXACTLY_ONE_GENERATED_VIEW_REQUIRED");
    if (defaultExports !== 0) add("DEFAULT_EXPORT_ASSIGNMENT_NOT_ALLOWED");
  }
  if (astNodes > input.limits.maxAstNodes) add("AST_LIMIT_EXCEEDED");
  if (maximumDepth > 80) add("DEPTH_LIMIT_EXCEEDED");
  if (complexity > input.limits.maxComplexity) add("COMPLEXITY_LIMIT_EXCEEDED");
  if ((sourceFile.statements.filter(ts.isFunctionDeclaration).some((fn) => fn.name && functionCallsName(fn, fn.name.text)))) add("RECURSION_NOT_ALLOWED");
  compareSet("runtimeImports", imports, input.manifest.runtimeImports, add);
  compareSet("sourceIds", references.sourceIds, input.manifest.sourceIds, add);
  compareSet("recordIds", references.recordIds, input.manifest.recordIds, add);
  compareSet("mediaIds", references.mediaIds, input.manifest.mediaIds, add);
  compareSet("capabilityIds", references.capabilityIds, input.manifest.capabilityIds, add);
  compareSet("emittedCommandKinds", references.emittedCommandKinds, input.manifest.emittedCommandKinds, add);
  return { valid: issues.length === 0, issues, astNodes, complexity, maximumDepth };
}

function isDeclarationName(node: ts.Identifier): boolean { const parent = node.parent; return (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isImportSpecifier(parent)) && parent.name === node; }
function hasJsxAttribute(node: ts.JsxOpeningLikeElement, name: string): boolean { return node.attributes.properties.some((item) => ts.isJsxAttribute(item) && item.name.getText() === name); }
function jsxStringAttribute(node: ts.JsxOpeningLikeElement, name: string): string | undefined { const item = node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText() === name); if (!item || !ts.isJsxAttribute(item) || !item.initializer) return undefined; if (ts.isStringLiteral(item.initializer)) return item.initializer.text; if (ts.isJsxExpression(item.initializer) && item.initializer.expression && ts.isStringLiteralLike(item.initializer.expression)) return item.initializer.expression.text; return undefined; }
function compareSet(label: string, actual: ReadonlySet<string>, expected: readonly string[], add: (code: string) => void): void { const wanted = new Set(expected); if (actual.size !== wanted.size || [...actual].some((value) => !wanted.has(value))) add(`MANIFEST_${label.replace(/([A-Z])/g, "_$1").toUpperCase()}_MISMATCH`); }
function functionCallsName(fn: ts.FunctionDeclaration, name: string): boolean { let found = false; const scan = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found = true; ts.forEachChild(node, scan); }; if (fn.body) scan(fn.body); return found; }
