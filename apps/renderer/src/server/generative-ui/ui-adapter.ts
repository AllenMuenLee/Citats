import { Buffer } from "node:buffer";
import {
  MAX_UI_GENERATION_IMPORTS,
  MAX_UI_GENERATION_LOCAL_INTERACTIONS,
  MAX_UI_GENERATION_MANIFEST_REFERENCES,
  MAX_UI_GENERATION_SOURCE_BYTES,
  OPAQUE_HANDLE_MAX_LENGTH,
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
 * The UI agent only ever needs one non-streaming, schema-constrained
 * completion with no tools, which is exactly `TextCompletion` -- so this
 * adapter is provider-agnostic: `UI_MODEL_PROVIDER` decides whether Gemini
 * or Groq answers, and nothing here changes.
 */
export type UiTransportRequest = TextCompletionRequest;
export type UiTransport = TextCompletion;
export interface SafeValidationIssue { readonly code: string; readonly line?: number; readonly column?: number }

export interface UiAdapterOptions {
  readonly model: string;
  readonly compilerVersion: string;
  readonly maxTokens: number;
  readonly deadlineMs: number;
  readonly runtimeExports: readonly string[];
  readonly transport: UiTransport;
  readonly validate?: (response: UiGenerationResponse) => Promise<readonly SafeValidationIssue[]>;
  readonly emitMetric?: (metric: UiGenerationMetric) => void;
  readonly now?: () => number;
}

export class UiGenerationAdapterError extends Error {
  constructor(readonly category: UiGenerationValidationCategory, message: string) { super(message); }
}

/** Mirrors `OpaqueHandleSchema` (`packages/contracts/src/page-understanding/common.ts`). */
const OPAQUE_HANDLE_JSON_SCHEMA = {
  type: "string", minLength: 1, maxLength: OPAQUE_HANDLE_MAX_LENGTH, pattern: "^[A-Za-z0-9._:-]+$",
} as const;

/** Mirrors `GeneratedUiArtifactManifestSchema` (`packages/contracts/src/generated-ui.ts`) field-for-field, so the model is contractually forced to use its exact key names and enum values rather than inventing plausible-looking ones (e.g. `commandKinds` instead of `emittedCommandKinds`). */
const MANIFEST_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["observationIds", "sourceIds", "recordIds", "mediaIds", "capabilityIds", "emittedCommandKinds", "localInteractions", "accessibilityFeatures", "responsiveRegions", "runtimeImports", "fallback"],
  properties: {
    observationIds: { type: "array", minItems: 1, maxItems: MAX_UI_GENERATION_MANIFEST_REFERENCES, items: OPAQUE_HANDLE_JSON_SCHEMA },
    sourceIds: { type: "array", maxItems: MAX_UI_GENERATION_MANIFEST_REFERENCES, items: OPAQUE_HANDLE_JSON_SCHEMA },
    recordIds: { type: "array", maxItems: MAX_UI_GENERATION_MANIFEST_REFERENCES, items: OPAQUE_HANDLE_JSON_SCHEMA },
    mediaIds: { type: "array", maxItems: MAX_UI_GENERATION_MANIFEST_REFERENCES, items: OPAQUE_HANDLE_JSON_SCHEMA },
    capabilityIds: { type: "array", maxItems: MAX_UI_GENERATION_MANIFEST_REFERENCES, items: OPAQUE_HANDLE_JSON_SCHEMA },
    emittedCommandKinds: { type: "array", maxItems: 16, items: { enum: ["activate", "select", "set_value", "open_detail", "media_control"] } },
    localInteractions: {
      type: "array", maxItems: MAX_UI_GENERATION_LOCAL_INTERACTIONS,
      items: {
        type: "object", additionalProperties: false,
        required: ["stateKey", "kind", "boundedValues"],
        properties: {
          stateKey: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" },
          kind: { enum: ["selection", "filter", "sort", "expansion", "tab", "gallery", "modal"] },
          boundedValues: { type: "integer", minimum: 1, maximum: 10_000 },
        },
      },
    },
    accessibilityFeatures: { type: "array", maxItems: 16, items: { enum: ["heading_order", "landmarks", "labels", "descriptions", "table_relationships", "live_status", "keyboard", "visible_focus", "accessible_media", "modal_escape"] } },
    responsiveRegions: { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 100 } },
    runtimeImports: { type: "array", maxItems: MAX_UI_GENERATION_IMPORTS, items: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z][A-Za-z0-9]*$" } },
    fallback: { type: "boolean" },
  },
} as const;

const responseSchema: Record<string, unknown> = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "tsxSource", "manifest", "modelIdentifier", "promptDigest", "inputDigest", "runtimeVersion", "toolchainVersion", "fallbackReason"],
  properties: {
    schemaVersion: { const: 1 }, tsxSource: { type: ["string", "null"], maxLength: MAX_UI_GENERATION_SOURCE_BYTES },
    manifest: MANIFEST_JSON_SCHEMA, modelIdentifier: { type: "string" }, promptDigest: { type: "string" },
    inputDigest: { type: "string" }, runtimeVersion: { type: "string" }, toolchainVersion: { type: "string" },
    fallbackReason: { type: ["string", "null"] },
  },
};

function normalizeIssues(issues: readonly SafeValidationIssue[]): string {
  return JSON.stringify({
    repair: issues.slice(0, 64).map((issue) => ({
      code: issue.code.replace(/[^A-Z0-9_]/gi, "_").toUpperCase().slice(0, 100),
      ...(issue.line === undefined ? {} : { line: issue.line }),
      ...(issue.column === undefined ? {} : { column: issue.column }),
    })),
  });
}

/** Fraction of the full token budget given to the structural draft pass (see `generate`). */
const DRAFT_TOKEN_FRACTION = 0.4;

function draftContext(draft: UiGenerationResponse): string {
  return JSON.stringify({
    priorDraft: { tsxSource: draft.tsxSource, manifest: draft.manifest },
    continuation: "This is your own draft from a smaller first pass. Build on it: keep whatever "
      + "already satisfies the task, complete any gaps, and ensure the final response fully "
      + "satisfies the output contract, limits, and every rule in the system instruction.",
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
      const canonical = buildCanonicalUiModelInput(request, options.runtimeExports);
      const controller = new AbortController();
      const onAbort = () => controller.abort(externalSignal?.reason);
      externalSignal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error("deadline exceeded")), options.deadlineMs);
      const base = {
        model: options.model, temperature: 0,
        systemInstruction: UI_GENERATION_SYSTEM_PROMPT,
        responseFormat: { name: "ui_generation_response", strict: true, schema: responseSchema },
      };
      const call = async (maxTokens: number, userContent: string): Promise<UiGenerationResponse> => {
        const result = await options.transport({ ...base, maxTokens, userContent }, controller.signal);
        let raw: unknown;
        try { raw = JSON.parse(result.content); } catch { category = "parse"; throw new UiGenerationAdapterError("parse", "UI model returned invalid structured JSON"); }
        // modelIdentifier, promptDigest, inputDigest, runtimeVersion, and toolchainVersion are
        // never trusted from the model -- each is already known server-side (promptDigest and
        // inputDigest are exact hash equality checks the model cannot reliably reproduce
        // verbatim; runtimeVersion/toolchainVersion are this deployment's fixed version
        // strings, not something the model has any way to know), so they are always overwritten
        // with the real values before validation.
        if (raw && typeof raw === "object") {
          const record = raw as Record<string, unknown>;
          record.modelIdentifier = result.model;
          record.promptDigest = request.promptDigest;
          record.inputDigest = canonical.inputDigest;
          record.runtimeVersion = request.runtimeApiVersion;
          record.toolchainVersion = options.compilerVersion;
        }
        try { return validateUiGenerationResponseForRequest(request, UiGenerationResponseSchema.parse(raw)); }
        catch (contractError) {
          category = "contract";
          console.error("[generative-ui] response failed its closed contract", contractError, JSON.stringify(raw).slice(0, 4000));
          throw new UiGenerationAdapterError("contract", "UI model response failed its closed contract");
        }
      };
      try {
        // Stage 1: a smaller, cheaper structural draft instead of asking for
        // the whole finished component in one large call. This is far less
        // likely to be the call that times out or gets truncated, and gives
        // the finishing pass below a concrete starting point -- its own
        // prior work as context -- instead of the entire task at once.
        const draftMaxTokens = Math.max(1, Math.round(options.maxTokens * DRAFT_TOKEN_FRACTION));
        const draft = await call(draftMaxTokens, canonical.serialized);
        sourceBytes = draft.tsxSource === null ? 0 : Buffer.byteLength(draft.tsxSource, "utf8");
        fallbackReason = draft.fallbackReason;
        if (!draft.tsxSource || draft.fallbackReason) { category = "accepted"; return draft; }

        let userContent = `${canonical.serialized}\n${draftContext(draft)}`;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await call(options.maxTokens, userContent);
          sourceBytes = response.tsxSource === null ? 0 : Buffer.byteLength(response.tsxSource, "utf8");
          fallbackReason = response.fallbackReason;
          const issues = await options.validate?.(response) ?? [];
          if (issues.length === 0) { category = "accepted"; return response; }
          console.error(`[generative-ui] source validation issues (attempt ${attempt})`, issues, response.tsxSource);
          if (attempt === 1) { category = "pipeline"; throw new UiGenerationAdapterError("pipeline", "UI generation failed validation after one repair"); }
          repaired = true;
          userContent = `${canonical.serialized}\n${draftContext(draft)}\n${normalizeIssues(issues)}`;
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
