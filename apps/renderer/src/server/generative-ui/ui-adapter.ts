import { Buffer } from "node:buffer";
import {
  UiGenerationResponseSchema,
  validateUiGenerationResponseForRequest,
  type UiGenerationRequest,
  type UiGenerationResponse,
} from "@ai-browser/contracts";
import { ModelProviderError, type TextCompletion, type TextCompletionRequest } from "../ai/types";
import { buildCanonicalUiModelInput } from "./canonical-input";
import type { UiGenerationMetric, UiGenerationValidationCategory } from "./metrics";
import { UI_GENERATION_SYSTEM_PROMPT } from "./system-prompt";

/**
 * The `UI_MODEL` adapter (P04-F02).
 *
 * One non-streaming completion, no tools of any kind, no conversation
 * history, temperature zero, and no internal deadline. No provider
 * structured-output schema is sent: the model returns one plain JSON object
 * whose shape the system instruction describes, and the closed Zod contract
 * plus the compiler are what actually trust it. The planner's free-form
 * implementation prompt (inside the canonical request) is the *sole*
 * variable payload; the system instruction is the server's.
 *
 * Nothing the model returns is allowed to affect the pipeline: the model
 * identifier, both digests, the runtime version, and the toolchain version
 * are overwritten with the server's own values before validation, so a
 * model cannot claim a different prompt or a different runtime than the one
 * it was actually given.
 */
export type UiTransportRequest = TextCompletionRequest;
export type UiTransport = TextCompletion;

export interface SafeValidationIssue {
  readonly code: string;
  readonly line?: number;
  readonly column?: number;
  /**
   * An already-sanitized one-liner. Callers pass only server-authored text
   * or a pattern-extracted identifier here -- never a raw provider or page
   * string -- and `normalizeIssues` re-bounds it before it reaches the model.
   */
  readonly message?: string;
}

export interface UiAdapterOptions {
  readonly model: string;
  readonly compilerVersion: string;
  readonly maxTokens: number;
  readonly transport: UiTransport;
  readonly validate?: (response: UiGenerationResponse) => Promise<readonly SafeValidationIssue[]>;
  readonly emitMetric?: (metric: UiGenerationMetric) => void;
  readonly now?: () => number;
}

export class UiGenerationAdapterError extends Error {
  constructor(readonly category: UiGenerationValidationCategory, message: string) {
    super(message);
    this.name = "UiGenerationAdapterError";
  }
}

/**
 * Pulls the JSON object out of a plain-text model reply. The UI model is
 * asked for one JSON object and nothing else, but nothing at the provider
 * enforces that, so a stray ```json fence or a sentence of preamble is
 * tolerated here rather than failing the call. Everything the object
 * *contains* is still validated by the closed Zod contract and the
 * compiler downstream -- this only finds the braces.
 */
function extractJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) throw new UiGenerationAdapterError("parse", "UI model returned no JSON object");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

/**
 * Server-owned, one-line fix instructions per validation code. This text is
 * this deployment's own -- it never contains model output or page content --
 * so attaching it to a repair turn adds no untrusted channel, and it turns
 * an opaque code the model shrugs at into an actionable correction.
 */
const REPAIR_HINTS: Readonly<Record<string, string>> = {
  INVALID_VIEW_PROPS: 'The component signature must be exactly `export default function GeneratedView(props: GeneratedViewProps) { ... }` -- one parameter named props, typed GeneratedViewProps, not destructured.',
  DYNAMIC_REFERENCE_ID: 'props.getSource(...) takes a string literal argument only, e.g. props.getSource("src-1"). Do not pass a variable or expression.',
  DEFAULT_EXPORT_REQUIRED: "Declare the component as `export default function GeneratedView`.",
  RUNTIME_EXPORT_NOT_ALLOWED: "Import only names that appear in the RUNTIME API declarations. Remove any other import.",
  IMPORT_SHAPE_NOT_ALLOWED: 'Use one named import: `import { A, B } from "@ai-browser/generated-ui-runtime";` -- no default or namespace import.',
  IMPORT_ALIAS_NOT_ALLOWED: "Import runtime names directly without `as` aliases.",
  IMPORT_NOT_ALLOWED: 'The only allowed import is from "@ai-browser/generated-ui-runtime".',
  FORBIDDEN_GLOBAL: "Remove the reference to a browser/host global. You may only use the runtime imports and props.",
  DYNAMIC_PROPERTY_ACCESS: 'Index objects with a string literal (obj["key"]) or dot access, never a computed expression.',
  DANGEROUS_JSX_ATTRIBUTE: "Remove the ref / autoFocus / dangerouslySetInnerHTML / srcSet attribute.",
  FORBIDDEN_JSX_ELEMENT: "Use only the runtime components and allowed intrinsic tags (div, span, section, button, table...). No a, img, form, iframe.",
  JSX_SPREAD_NOT_ALLOWED: "Pass props explicitly; do not spread {...props} onto an element.",
  LOOP_NOT_ALLOWED: "Use array methods (map/filter) over literal data instead of for/while loops.",
  CONSTRUCTION_NOT_ALLOWED: "Do not use `new`. Use the runtime formatters (formatNumber, formatCurrency, formatDate).",
  EXECUTABLE_OR_EXTERNAL_URL: "Do not write a string containing a URL or a URL scheme. Source URLs come from props.",
  CSS_EXFILTRATION: "Do not use url(), image-set(), expression(), or @import in style values.",
  TYPE_CHECK_2554: "A runtime function was called with the wrong number of arguments. useBoundedState(initial, allowedArray) and useLocalCollection(items, { filter, compare }) both take two positional arguments -- not one config object.",
  TYPE_CHECK_2353: "An object literal has keys the target type does not accept -- you are passing a config object where positional arguments are expected. Follow the RUNTIME API signatures exactly.",
  TYPE_CHECK_2304: "A name is used but never declared or imported. Declare it, import it, or remove the reference.",
  TYPE_CHECK_7006: "A callback parameter has an implicit any type. Add an explicit type annotation, or use a parameterless handler.",
  TYPE_CHECK_2551: "A property does not exist on the type. Check the RUNTIME API declarations; semanticTokens keys are camelCase (space8, textPrimary, radiusPanel).",
  TYPE_OR_TRANSPILE_ERROR: "The component does not compile. Re-check every runtime call against the RUNTIME API declarations.",
};

function hintFor(code: string): string | undefined {
  return REPAIR_HINTS[code] ?? REPAIR_HINTS[code.replace(/_\d+$/, "")];
}

/**
 * Repair instruction for a reply that did not parse as one JSON object --
 * cut off at the token ceiling, wrapped in prose, or handed back as a bare
 * code block. Server-owned text in the same envelope `normalizeIssues`
 * produces; no model output is echoed back.
 */
const MALFORMED_REPLY_REPAIR = JSON.stringify({
  repair: [{
    code: "MALFORMED_REPLY",
    hint: "Your previous reply was not a single valid JSON object -- it was cut off, or wrapped in prose or a ``` fence. Reply with ONLY the JSON object the system instruction describes: no preamble, no fence, and keep tsxSource as short as it can be while still meeting the request.",
  }],
});

/**
 * Validator feedback for the bounded repair attempts, normalized to codes,
 * safe locations, and server-owned fix hints. The model's own output is
 * never echoed back, so the repair turn cannot become a second channel for
 * anything untrusted.
 */
function normalizeIssues(issues: readonly SafeValidationIssue[]): string {
  return JSON.stringify({
    repair: issues.slice(0, 64).map((issue) => {
      const code = issue.code.replace(/[^A-Z0-9_]/gi, "_").toUpperCase().slice(0, 100);
      const hint = hintFor(code);
      const detail = issue.message?.replace(/[^\w '".,()<>:?/@$-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
      return {
        code,
        ...(issue.line === undefined ? {} : { line: issue.line }),
        ...(issue.column === undefined ? {} : { column: issue.column }),
        ...(detail ? { detail } : {}),
        ...(hint ? { hint } : {}),
      };
    }),
  });
}

export function createUiGenerationAdapter(options: UiAdapterOptions) {
  return {
    async generate(request: UiGenerationRequest, externalSignal?: AbortSignal): Promise<UiGenerationResponse> {
      const started = options.now?.() ?? Date.now();
      let category: UiGenerationValidationCategory = "provider";
      let repaired = false;
      let sourceBytes = 0;
      let fallbackReason: string | null = null;
      const canonical = buildCanonicalUiModelInput(request);
      const controller = new AbortController();
      const onAbort = () => controller.abort(externalSignal?.reason);
      externalSignal?.addEventListener("abort", onAbort, { once: true });
      if (externalSignal?.aborted) onAbort();
      // No provider structured-output schema: the model returns one plain
      // JSON object described by the system instruction. The closed Zod
      // contract and the compiler are what actually trust the reply.
      const base = {
        model: options.model,
        temperature: 0,
        systemInstruction: UI_GENERATION_SYSTEM_PROMPT,
      };
      const call = async (maxTokens: number, userContent: string): Promise<UiGenerationResponse> => {
        const aborted = new Promise<never>((_resolve, reject) => {
          const rejectAbort = () => reject(controller.signal.reason ?? new Error("UI generation aborted"));
          if (controller.signal.aborted) rejectAbort();
          else controller.signal.addEventListener("abort", rejectAbort, { once: true });
        });
        const result = await Promise.race([
          options.transport({ ...base, maxTokens, userContent }, controller.signal),
          aborted,
        ]);
        let raw: unknown;
        try {
          raw = extractJsonObject(result.content);
        } catch (error) {
          category = "parse";
          console.error("[generative-ui] unparseable UI model reply", {
            length: result.content.length,
            head: result.content.slice(0, 300),
            tail: result.content.slice(-300),
          });
          if (error instanceof UiGenerationAdapterError) throw error;
          throw new UiGenerationAdapterError("parse", "UI model returned no parseable JSON object");
        }
        // Every identity field is the server's, not the model's: the digests
        // are exact hash equalities the model cannot reproduce, and the
        // runtime/toolchain versions are this deployment's own.
        if (raw && typeof raw === "object") {
          const record = raw as Record<string, unknown>;
          // A model that wrapped the source in its own ```tsx fence is not
          // failed for it -- the fence is stripped and the code kept.
          if (typeof record.tsxSource === "string") {
            record.tsxSource = record.tsxSource
              .replace(/^\s*```(?:tsx|typescript|ts|jsx|js)?\s*\n?/i, "")
              .replace(/\n?\s*```\s*$/i, "")
              .trim();
          }
          record.modelIdentifier = result.model;
          record.promptDigest = request.promptDigest;
          record.inputDigest = canonical.inputDigest;
          record.runtimeVersion = request.runtime.apiVersion;
          record.toolchainVersion = options.compilerVersion;
        }
        try {
          return validateUiGenerationResponseForRequest(request, UiGenerationResponseSchema.parse(raw));
        } catch (contractError) {
          category = "contract";
          console.error("[generative-ui] response failed its closed contract", contractError);
          throw new UiGenerationAdapterError("contract", "UI model response failed its closed contract");
        }
      };
      try {
        let userContent = canonical.serialized;
        // One generation, then at most two repairs driven by normalized
        // validator feedback with server-owned fix hints. Beyond that the
        // stage fails rather than spending the budget re-asking.
        const maxAttempts = 3;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          let response: UiGenerationResponse;
          try {
            response = await call(options.maxTokens, userContent);
          } catch (error) {
            // A reply that could not be parsed as one JSON object -- the
            // model ran past the token ceiling, or answered in prose -- is
            // spent like a failed validation: one repair attempt with a
            // corrective instruction rather than failing the whole stage.
            // A schema/contract failure is not retried here: the JSON was
            // well-formed and the mismatch is not something re-asking fixes.
            const malformed =
              (error instanceof UiGenerationAdapterError && error.category === "parse") ||
              (error instanceof ModelProviderError && error.code === "AI_MALFORMED_RESPONSE");
            if (!malformed || controller.signal.aborted || attempt === maxAttempts - 1) throw error;
            console.error(`[generative-ui] unparseable UI model reply (attempt ${attempt}), re-asking`);
            category = "parse";
            repaired = true;
            userContent = `${canonical.serialized}\n${MALFORMED_REPLY_REPAIR}`;
            continue;
          }
          sourceBytes = response.tsxSource === null ? 0 : Buffer.byteLength(response.tsxSource, "utf8");
          fallbackReason = response.fallbackReason;
          if (!response.tsxSource || response.fallbackReason) {
            category = "accepted";
            return response;
          }
          const issues = (await options.validate?.(response)) ?? [];
          if (issues.length === 0) {
            category = "accepted";
            return response;
          }
          console.error(`[generative-ui] source validation issues (attempt ${attempt})`, issues.map((issue) => issue.code));
          if (attempt === maxAttempts - 1) {
            category = "pipeline";
            throw new UiGenerationAdapterError("pipeline", "UI generation failed validation after repair attempts");
          }
          repaired = true;
          userContent = `${canonical.serialized}\n${normalizeIssues(issues)}`;
        }
        throw new UiGenerationAdapterError("pipeline", "UI generation repair bound exhausted");
      } catch (error) {
        if (controller.signal.aborted) {
          category = "cancelled";
          throw new UiGenerationAdapterError(category, "UI generation was cancelled");
        }
        throw error;
      } finally {
        externalSignal?.removeEventListener("abort", onAbort);
        options.emitMetric?.({ latencyMs: (options.now?.() ?? Date.now()) - started, validationCategory: category, cacheResult: "miss", sourceBytes, fallbackReason, repaired });
      }
    },
  };
}
