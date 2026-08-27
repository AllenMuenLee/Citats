import { Buffer } from "node:buffer";
import {
  MAX_UI_GENERATION_SOURCE_BYTES,
  UiGenerationResponseSchema,
  validateUiGenerationResponseForRequest,
  type UiGenerationRequest,
  type UiGenerationResponse,
} from "@ai-browser/contracts";
import { buildCanonicalUiModelInput } from "./canonical-input";
import type { UiGenerationMetric, UiGenerationValidationCategory } from "./metrics";
import { UI_GENERATION_SYSTEM_PROMPT } from "./system-prompt";

export interface MistralUiTransportRequest {
  readonly model: string;
  readonly temperature: 0;
  readonly maxTokens: number;
  readonly messages: readonly [{ readonly role: "system"; readonly content: string }, { readonly role: "user"; readonly content: string }];
  readonly tools: readonly [];
  readonly toolChoice: "none";
  readonly responseFormat: { readonly type: "json_schema"; readonly jsonSchema: { readonly name: string; readonly strict: true; readonly schema: Record<string, unknown> } };
}

export interface MistralUiTransportResult { readonly model: string; readonly content: string }
export type MistralUiTransport = (request: MistralUiTransportRequest, signal: AbortSignal) => Promise<MistralUiTransportResult>;
export interface SafeValidationIssue { readonly code: string; readonly line?: number; readonly column?: number }

export interface MistralUiAdapterOptions {
  readonly model: string;
  readonly compilerVersion: string;
  readonly maxTokens: number;
  readonly deadlineMs: number;
  readonly runtimeExports: readonly string[];
  readonly transport: MistralUiTransport;
  readonly validate?: (response: UiGenerationResponse) => Promise<readonly SafeValidationIssue[]>;
  readonly emitMetric?: (metric: UiGenerationMetric) => void;
  readonly now?: () => number;
}

export class UiGenerationAdapterError extends Error {
  constructor(readonly category: UiGenerationValidationCategory, message: string) { super(message); }
}

const responseSchema: Record<string, unknown> = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "tsxSource", "manifest", "modelIdentifier", "promptDigest", "inputDigest", "runtimeVersion", "toolchainVersion", "fallbackReason"],
  properties: {
    schemaVersion: { const: 1 }, tsxSource: { type: ["string", "null"], maxLength: MAX_UI_GENERATION_SOURCE_BYTES },
    manifest: { type: "object" }, modelIdentifier: { type: "string" }, promptDigest: { type: "string" },
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

export function createMistralUiGenerationAdapter(options: MistralUiAdapterOptions) {
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
        model: options.model, temperature: 0 as const, maxTokens: options.maxTokens,
        tools: [] as const, toolChoice: "none" as const,
        responseFormat: { type: "json_schema" as const, jsonSchema: { name: "ui_generation_response", strict: true as const, schema: responseSchema } },
      };
      try {
        let userContent = canonical.serialized;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await options.transport({ ...base, messages: [{ role: "system", content: UI_GENERATION_SYSTEM_PROMPT }, { role: "user", content: userContent }] }, controller.signal);
          let raw: unknown;
          try { raw = JSON.parse(result.content); } catch { category = "parse"; throw new UiGenerationAdapterError("parse", "UI model returned invalid structured JSON"); }
          if (raw && typeof raw === "object") (raw as Record<string, unknown>).modelIdentifier = result.model;
          let response: UiGenerationResponse;
          try { response = validateUiGenerationResponseForRequest(request, UiGenerationResponseSchema.parse(raw)); }
          catch { category = "contract"; throw new UiGenerationAdapterError("contract", "UI model response failed its closed contract"); }
          sourceBytes = response.tsxSource === null ? 0 : Buffer.byteLength(response.tsxSource, "utf8");
          fallbackReason = response.fallbackReason;
          const issues = await options.validate?.(response) ?? [];
          if (issues.length === 0) { category = "accepted"; return response; }
          if (attempt === 1) { category = "pipeline"; throw new UiGenerationAdapterError("pipeline", "UI generation failed validation after one repair"); }
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
