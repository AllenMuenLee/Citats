import { Buffer } from "node:buffer";
import {
  MAX_UI_GENERATION_IMPORTS,
  MAX_UI_GENERATION_LOCAL_INTERACTIONS,
  MAX_UI_GENERATION_MANIFEST_REFERENCES,
  UiGenerationResponseSchema,
  validateUiGenerationResponseForRequest,
  type UiGenerationRequest,
  type UiGenerationResponse,
} from "@ai-browser/contracts";
import type { TextCompletion, TextCompletionRequest } from "../ai/types";
import { buildCanonicalUiModelInput } from "./canonical-input";
import type { UiGenerationMetric, UiGenerationValidationCategory } from "./metrics";
import { UI_GENERATION_SYSTEM_PROMPT } from "./system-prompt";

/**
 * The `UI_MODEL` adapter (P04-F02).
 *
 * One non-streaming, schema-constrained completion, no tools of any kind,
 * no conversation history, temperature zero, and a hard deadline. The
 * canonical `UiPlan` is the *sole* variable payload; the system instruction
 * and the response schema are the server's.
 *
 * Nothing the model returns is allowed to affect the pipeline: the model
 * identifier, both digests, the runtime version, and the toolchain version
 * are overwritten with the server's own values before validation, so a
 * model cannot claim a different plan, a different prompt, or a different
 * runtime than the one it was actually given.
 */
export type UiTransportRequest = TextCompletionRequest;
export type UiTransport = TextCompletion;

export interface SafeValidationIssue {
  readonly code: string;
  readonly line?: number;
  readonly column?: number;
}

export interface UiAdapterOptions {
  readonly model: string;
  readonly compilerVersion: string;
  readonly maxTokens: number;
  readonly deadlineMs: number;
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

const PLAN_REFERENCE_JSON_SCHEMA = { type: "string" } as const;

/**
 * Mirrors `GeneratedUiArtifactManifestSchema` field for field, so the model
 * is contractually forced to use its exact key names and enum values rather
 * than inventing plausible-looking ones. String length bounds are omitted
 * for the same constrained-decoding reason as the plan schema; the manifest
 * is re-validated afterwards, which is where the bounds are enforced.
 */
const MANIFEST_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "planDigest",
    "sourceIds",
    "recordIds",
    "factIds",
    "mediaIds",
    "componentIds",
    "localInteractions",
    "accessibilityFeatures",
    "responsiveRegions",
    "runtimeImports",
    "fallback",
  ],
  properties: {
    planDigest: { type: "string" },
    sourceIds: { type: "array", maxItems: MAX_UI_GENERATION_MANIFEST_REFERENCES, items: PLAN_REFERENCE_JSON_SCHEMA },
    recordIds: { type: "array", maxItems: MAX_UI_GENERATION_MANIFEST_REFERENCES, items: PLAN_REFERENCE_JSON_SCHEMA },
    factIds: { type: "array", maxItems: MAX_UI_GENERATION_MANIFEST_REFERENCES, items: PLAN_REFERENCE_JSON_SCHEMA },
    mediaIds: { type: "array", maxItems: MAX_UI_GENERATION_MANIFEST_REFERENCES, items: PLAN_REFERENCE_JSON_SCHEMA },
    componentIds: { type: "array", maxItems: MAX_UI_GENERATION_MANIFEST_REFERENCES, items: PLAN_REFERENCE_JSON_SCHEMA },
    localInteractions: {
      type: "array",
      maxItems: MAX_UI_GENERATION_LOCAL_INTERACTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stateKey", "kind", "boundedValues"],
        properties: {
          stateKey: { type: "string" },
          kind: { type: "string", enum: ["selection", "filter", "sort", "expansion", "tab", "gallery", "modal"] },
          boundedValues: { type: "integer", minimum: 1, maximum: 10_000 },
        },
      },
    },
    accessibilityFeatures: {
      type: "array",
      maxItems: 16,
      items: {
        type: "string",
        enum: [
          "heading_order",
          "landmarks",
          "labels",
          "descriptions",
          "table_relationships",
          "live_status",
          "keyboard",
          "visible_focus",
          "accessible_media",
          "modal_escape",
        ],
      },
    },
    responsiveRegions: { type: "array", maxItems: 64, items: { type: "string" } },
    runtimeImports: { type: "array", maxItems: MAX_UI_GENERATION_IMPORTS, items: { type: "string" } },
    fallback: { type: "boolean" },
  },
} as const;

const responseSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "tsxSource",
    "manifest",
    "modelIdentifier",
    "promptDigest",
    "inputDigest",
    "runtimeVersion",
    "toolchainVersion",
    "fallbackReason",
  ],
  properties: {
    schemaVersion: { const: 1 },
    // No `maxLength` on `tsxSource`: a 64 KiB bound is the single largest
    // constrained-decoding cost in this schema, and it is redundant --
    // `UiGenerationResponseSchema` rejects an oversized source on parse.
    tsxSource: { type: ["string", "null"] },
    manifest: MANIFEST_JSON_SCHEMA,
    modelIdentifier: { type: "string" },
    promptDigest: { type: "string" },
    inputDigest: { type: "string" },
    runtimeVersion: { type: "string" },
    toolchainVersion: { type: "string" },
    fallbackReason: { type: ["string", "null"] },
  },
};

/**
 * Validator feedback for the single repair attempt, normalized to codes and
 * safe locations. The model's own output is never echoed back, so the
 * repair turn cannot become a second channel for anything untrusted.
 */
function normalizeIssues(issues: readonly SafeValidationIssue[]): string {
  return JSON.stringify({
    repair: issues.slice(0, 64).map((issue) => ({
      code: issue.code.replace(/[^A-Z0-9_]/gi, "_").toUpperCase().slice(0, 100),
      ...(issue.line === undefined ? {} : { line: issue.line }),
      ...(issue.column === undefined ? {} : { column: issue.column }),
    })),
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
      const timeout = setTimeout(() => controller.abort(new Error("deadline exceeded")), options.deadlineMs);
      const base = {
        model: options.model,
        temperature: 0,
        systemInstruction: UI_GENERATION_SYSTEM_PROMPT,
        responseFormat: { name: "ui_generation_response", strict: true, schema: responseSchema },
      };
      const call = async (maxTokens: number, userContent: string): Promise<UiGenerationResponse> => {
        const result = await options.transport({ ...base, maxTokens, userContent }, controller.signal);
        let raw: unknown;
        try {
          raw = JSON.parse(result.content);
        } catch {
          category = "parse";
          throw new UiGenerationAdapterError("parse", "UI model returned invalid structured JSON");
        }
        // Every identity field is the server's, not the model's: the digests
        // are exact hash equalities the model cannot reproduce, and the
        // runtime/toolchain versions are this deployment's own.
        if (raw && typeof raw === "object") {
          const record = raw as Record<string, unknown>;
          record.modelIdentifier = result.model;
          record.promptDigest = request.promptDigest;
          record.inputDigest = canonical.inputDigest;
          record.runtimeVersion = request.runtime.apiVersion;
          record.toolchainVersion = options.compilerVersion;
          const manifest = record.manifest;
          if (manifest && typeof manifest === "object") (manifest as Record<string, unknown>).planDigest = request.planDigest;
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
        // One generation, then at most one repair driven by normalized
        // validator feedback. Beyond that the stage fails rather than
        // spending the budget re-asking.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await call(options.maxTokens, userContent);
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
          if (attempt === 1) {
            category = "pipeline";
            throw new UiGenerationAdapterError("pipeline", "UI generation failed validation after one repair");
          }
          repaired = true;
          userContent = `${canonical.serialized}\n${normalizeIssues(issues)}`;
        }
        throw new UiGenerationAdapterError("pipeline", "UI generation repair bound exhausted");
      } catch (error) {
        if (controller.signal.aborted) {
          category = externalSignal?.aborted ? "cancelled" : "timeout";
          throw new UiGenerationAdapterError(category, category === "cancelled" ? "UI generation was cancelled" : "UI generation deadline exceeded");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", onAbort);
        options.emitMetric?.({ latencyMs: (options.now?.() ?? Date.now()) - started, validationCategory: category, cacheResult: "miss", sourceBytes, fallbackReason, repaired });
      }
    },
  };
}
