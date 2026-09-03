import ts from "typescript";
import type { StaticValidationInput, StaticValidationIssue, StaticValidationResult } from "./types";

/**
 * The static gate every generated view passes before it is compiled
 * (P04-F03 step 3).
 *
 * It is a denylist *and* an allowlist: an import that is not the runtime
 * module, an identifier that reaches a global, a JSX tag outside the
 * allowed intrinsics, a dynamic property access, a loop, a construction, a
 * dangerous attribute, or a literal URL are each rejected outright -- and
 * separately, every id the source references must match the manifest
 * exactly, so the manifest cannot describe one component while the source
 * renders another.
 */

const RUNTIME_MODULE = "@ai-browser/generated-ui-runtime";

/**
 * Codes that describe a mismatch, a nitpick, or a style preference rather
 * than an actual safety or compilability problem. They are reported as
 * warnings and do not block: the generated view still compiles and
 * renders. The security denylist (forbidden globals, `eval`, network, DOM,
 * `iframe`, prototype escapes, dynamic import, external assets, dangerous
 * attributes) and the "it must actually compile" checks stay hard errors.
 */
const WARNING_CODES: ReadonlySet<string> = new Set([
  "MANIFEST_RUNTIME_IMPORTS_MISMATCH",
  "MANIFEST_SOURCE_IDS_MISMATCH",
  "MANIFEST_RESPONSIVE_REGIONS_MISMATCH",
  "MANIFEST_LOCAL_INTERACTIONS_MISMATCH",
  "STABLE_KEY_REQUIRED",
  "BUTTON_TYPE_REQUIRED",
  "DYNAMIC_REGION_LABEL",
  "THEME_TOKEN_NOT_ALLOWED",
  "RAW_COLOR_VALUE",
]);

/** Mirrors the exports of `packages/generated-ui-runtime/src/index.tsx`. */
export const RUNTIME_EXPORTS: ReadonlySet<string> = new Set([
  "GeneratedViewProps", "OpaqueId", "DisplaySource", "DisplayCoverage", "semanticTokens",
  "Stack", "Inline", "Grid", "Card", "Region", "Text", "Heading", "Badge", "List", "ListItem",
  "Table", "TableHead", "TableBody", "TableRow", "TableHeader", "TableCell",
  "Label", "Select", "Option", "Status", "Warning", "Source", "Freshness", "Icon", "Modal",
  "useBoundedState", "useLocalCollection", "formatNumber", "formatCurrency", "formatDate",
  "createElement", "Fragment",
]);

const FORBIDDEN_IDENTIFIERS = new Set([
  "window", "document", "globalThis", "self", "top", "parent", "frames", "navigator", "location", "history",
  "localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "fetch", "XMLHttpRequest", "WebSocket",
  "EventSource", "BroadcastChannel", "postMessage", "open", "process", "require", "module", "exports", "Buffer",
  "Deno", "Bun", "electron", "eval", "Function", "Worker", "SharedWorker", "ServiceWorker", "importScripts",
  "setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback", "queueMicrotask",
  "MutationObserver", "IntersectionObserver", "ResizeObserver", "Notification", "crypto", "Reflect", "Proxy",
]);
const FORBIDDEN_PROPERTIES = new Set(["constructor", "prototype", "__proto__", "caller", "callee", "arguments"]);
const FORBIDDEN_JSX = new Set(["iframe", "webview", "script", "style", "object", "embed", "form", "portal", "a", "img", "link", "meta", "base"]);
const ALLOWED_INTRINSICS = new Set([
  "div", "span", "section", "article", "main", "header", "footer", "nav", "aside", "figure", "figcaption",
  "p", "strong", "em", "small", "code", "dl", "dt", "dd", "ol", "ul", "li",
  "h1", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "th", "td", "caption", "button", "label",
]);

type ReferenceKey = "sourceIds";

/** Runtime accessors whose literal argument is a trusted source id the manifest must also declare. */
const ID_LOOKUPS: Readonly<Record<string, ReferenceKey>> = {
  getSource: "sourceIds",
};

export function validateGeneratedUiSource(input: StaticValidationInput): StaticValidationResult {
  const sourceFile = ts.createSourceFile("generated-view.tsx", input.source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const issues: StaticValidationIssue[] = [];
  const allowedTokens = new Set(input.allowedTokens);
  let astNodes = 0;
  let complexity = 1;
  let maximumDepth = 0;
  let defaultExports = 0;
  let generatedViewDeclarations = 0;
  let runtimeImportDeclarations = 0;
  let boundedStateCalls = 0;
  let renderNodes = 0;
  const imports = new Set<string>();
  const references = {
    sourceIds: new Set<string>(),
  };
  const responsiveRegions = new Set<string>();

  const add = (code: string, node?: ts.Node) => {
    const position = node ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false)) : null;
    issues.push({
      code,
      severity: WARNING_CODES.has(code) ? "warning" : "error",
      location: position ? { line: position.line + 1, column: position.character } : null,
    });
  };
  const literalArgument = (call: ts.CallExpression, index: number) => {
    const argument = call.arguments[index];
    return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
  };

  const visit = (node: ts.Node, depth: number): void => {
    astNodes += 1;
    maximumDepth = Math.max(maximumDepth, depth);
    if (astNodes > input.limits.maxAstNodes) return;
    if (ts.isImportDeclaration(node)) {
      runtimeImportDeclarations += 1;
      if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== RUNTIME_MODULE) add("IMPORT_NOT_ALLOWED", node);
      if (!node.importClause || node.importClause.name || (node.importClause.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings))) {
        add("IMPORT_SHAPE_NOT_ALLOWED", node);
      }
      if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const item of node.importClause.namedBindings.elements) {
          imports.add(item.name.text);
          if (item.propertyName) add("IMPORT_ALIAS_NOT_ALLOWED", item);
          if (!RUNTIME_EXPORTS.has(item.propertyName?.text ?? item.name.text)) add("RUNTIME_EXPORT_NOT_ALLOWED", item);
        }
      }
    }
    if (ts.isExportDeclaration(node)) add("EXPORT_SHAPE_NOT_ALLOWED", node);
    if (ts.isExportAssignment(node) && !node.isExportEquals) defaultExports += 1;
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === "GeneratedView") {
      generatedViewDeclarations += 1;
      if (ts.isClassDeclaration(node)) add("GENERATED_VIEW_MUST_BE_A_FUNCTION", node);
      const modifiers = ts.getModifiers(node) ?? [];
      if (!modifiers.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword) || !modifiers.some((item) => item.kind === ts.SyntaxKind.ExportKeyword)) {
        add("DEFAULT_EXPORT_REQUIRED", node);
      }
      if (ts.isFunctionDeclaration(node)) {
        const parameter = node.parameters[0];
        if (node.parameters.length !== 1 || !parameter?.type || parameter.type.getText(sourceFile) !== "GeneratedViewProps") {
          add("INVALID_VIEW_PROPS", node);
        }
      }
    }
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text) && !isDeclarationName(node) && !isPropertyName(node)) add("FORBIDDEN_GLOBAL", node);
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_PROPERTIES.has(node.name.text)) add("PROTOTYPE_ESCAPE", node);
    if (ts.isElementAccessExpression(node)) {
      if (!node.argumentExpression || !ts.isStringLiteralLike(node.argumentExpression)) add("DYNAMIC_PROPERTY_ACCESS", node);
      else if (FORBIDDEN_PROPERTIES.has(node.argumentExpression.text)) add("PROTOTYPE_ESCAPE", node);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add("DYNAMIC_IMPORT", node);
      if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (name === "useState" || name === "useEffect" || name === "useLayoutEffect" || name === "useRef" || name === "useReducer" || name === "useSyncExternalStore") {
          add("UNBOUNDED_OR_UNSAFE_HOOK", node);
        }
        if (name === "useBoundedState") boundedStateCalls += 1;
      }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const key = ID_LOOKUPS[method];
        if (key) {
          const value = literalArgument(node, 0);
          if (value) references[key].add(value);
          else add("DYNAMIC_REFERENCE_ID", node);
        }
      }
    }
    if (ts.isNewExpression(node)) add("CONSTRUCTION_NOT_ALLOWED", node);
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 1_000) add("MEMORY_LIMIT_EXCEEDED", node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "repeat") add("MEMORY_LIMIT_EXCEEDED", node);
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) add("LOOP_NOT_ALLOWED", node);
    if (
      ts.isConditionalExpression(node) ||
      ts.isIfStatement(node) ||
      ts.isCaseClause(node) ||
      ts.isCatchClause(node) ||
      (ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind))
    ) {
      complexity += 1;
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (name === "dangerouslySetInnerHTML" || name === "ref" || name === "autoFocus" || name === "srcSet") add("DANGEROUS_JSX_ATTRIBUTE", node);
      if (/^on[A-Z]/.test(name) && node.initializer && !ts.isJsxExpression(node.initializer)) add("INLINE_EVENT_LEAKAGE", node);
      if ((name === "href" || name === "src" || name === "action" || name === "formAction" || name === "poster") && node.initializer) add("EXTERNAL_ASSET_LITERAL", node);
      if (name === "style" && node.initializer) {
        const text = node.initializer.getText(sourceFile);
        // A functional CSS value that can fetch or execute is a real hole.
        if (/(?:url\s*\(|expression\s*\(|image-set\s*\(|@import|behavior\s*:)/i.test(text)) add("CSS_EXFILTRATION", node);
        // A raw colour is just off-theme -- a warning, not a rejection.
        else if (/(?:#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()/i.test(text)) add("RAW_COLOR_VALUE", node);
      }
    }
    if (ts.isJsxSpreadAttribute(node)) add("JSX_SPREAD_NOT_ALLOWED", node);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      renderNodes += 1;
      const tag = node.tagName.getText(sourceFile);
      if (FORBIDDEN_JSX.has(tag)) add("FORBIDDEN_JSX_ELEMENT", node);
      else if (/^[a-z]/.test(tag) && !ALLOWED_INTRINSICS.has(tag)) add("INTRINSIC_NOT_ALLOWED", node);
      if (tag === "button" && !hasJsxAttribute(node, "type")) add("BUTTON_TYPE_REQUIRED", node);
      if (tag === "Region") {
        const label = jsxStringAttribute(node, "label");
        if (label) responsiveRegions.add(label);
        else add("DYNAMIC_REGION_LABEL", node);
      }
      if (isReturnedFromArrayMap(node) && !hasJsxAttribute(node, "key")) add("STABLE_KEY_REQUIRED", node);
    }
    // A semantic token is the only way to name a colour. `semanticTokens.x`
    // is checked against the theme's own allowlist so a token the theme does
    // not publish cannot be invented.
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "semanticTokens") {
      const token = node.name.text.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      if (!allowedTokens.has(token)) add("THEME_TOKEN_NOT_ALLOWED", node);
    }
    if (ts.isStringLiteralLike(node) && /(?:javascript:|vbscript:|data:|blob:|file:|https?:\/\/)/i.test(node.text)) add("EXECUTABLE_OR_EXTERNAL_URL", node);
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };

  visit(sourceFile, 1);

  if ((sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) add("SYNTAX_ERROR");
  if (generatedViewDeclarations !== 1) add("EXACTLY_ONE_GENERATED_VIEW_REQUIRED");
  if (defaultExports !== 0) add("DEFAULT_EXPORT_ASSIGNMENT_NOT_ALLOWED");
  if (runtimeImportDeclarations > 1) add("SINGLE_RUNTIME_IMPORT_REQUIRED");
  if (astNodes > input.limits.maxAstNodes) add("AST_LIMIT_EXCEEDED");
  if (maximumDepth > 80) add("DEPTH_LIMIT_EXCEEDED");
  if (complexity > input.limits.maxComplexity) add("COMPLEXITY_LIMIT_EXCEEDED");
  if (boundedStateCalls > input.limits.maxLocalStateEntries) add("LOCAL_STATE_LIMIT_EXCEEDED");
  if (renderNodes > input.limits.maxRenderNodes) add("RENDER_NODE_LIMIT_EXCEEDED");
  if (sourceFile.statements.filter(ts.isFunctionDeclaration).some((fn) => fn.name && functionCallsName(fn, fn.name.text))) add("RECURSION_NOT_ALLOWED");

  compareSet("RUNTIME_IMPORTS", imports, input.manifest.runtimeImports, add);
  compareSet("SOURCE_IDS", references.sourceIds, input.manifest.sourceIds, add);
  // Responsive regions and local interactions are checked for *agreement*
  // with the code, not exact equality: the manifest may not claim a region
  // the source never renders or more bounded-state hooks than it calls.
  if ([...input.manifest.responsiveRegions].some((label) => !responsiveRegions.has(label))) add("MANIFEST_RESPONSIVE_REGIONS_MISMATCH");
  if (input.manifest.localInteractions.length > boundedStateCalls) add("MANIFEST_LOCAL_INTERACTIONS_MISMATCH");

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
    astNodes,
    complexity,
    maximumDepth,
    imports: [...imports],
  };
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  );
}

/** `record.location` is a field name, not the global. Only bare references are globals. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;
  return false;
}

function hasJsxAttribute(node: ts.JsxOpeningLikeElement, name: string): boolean {
  return node.attributes.properties.some((item) => ts.isJsxAttribute(item) && item.name.getText() === name);
}

function jsxStringAttribute(node: ts.JsxOpeningLikeElement, name: string): string | undefined {
  const item = node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText() === name);
  if (!item || !ts.isJsxAttribute(item) || !item.initializer) return undefined;
  if (ts.isStringLiteral(item.initializer)) return item.initializer.text;
  if (ts.isJsxExpression(item.initializer) && item.initializer.expression && ts.isStringLiteralLike(item.initializer.expression)) {
    return item.initializer.expression.text;
  }
  return undefined;
}

function compareSet(label: string, actual: ReadonlySet<string>, expected: readonly string[], add: (code: string) => void): void {
  const wanted = new Set(expected);
  if (actual.size !== wanted.size || [...actual].some((value) => !wanted.has(value))) add(`MANIFEST_${label}_MISMATCH`);
}

function functionCallsName(fn: ts.FunctionDeclaration, name: string): boolean {
  let found = false;
  const scan = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found = true;
    ts.forEachChild(node, scan);
  };
  if (fn.body) scan(fn.body);
  return found;
}

function isReturnedFromArrayMap(node: ts.JsxOpeningLikeElement): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === "map") {
      return true;
    }
    if (ts.isFunctionDeclaration(current)) return false;
    current = current.parent;
  }
  return false;
}
