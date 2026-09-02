import "server-only";

import { z } from "zod";
import type { TextCompletion } from "../../ai/types";
import { UiGenerateStageError, type SourceFindingStage, type ValidatedSource } from "../types";
import {
  readSourceOriginPolicy,
  validateCandidateUrls,
  type AddressLookup,
  type SourceOriginPolicy,
} from "./url-policy";

/**
 * Stage 1 of `ui.generate`: `SOURCE_FINDING_MODEL` proposes websites
 * (P03-F01).
 *
 * The model is given no tools, no hosted tools, no conversation history,
 * and temperature zero. It returns strict JSON and nothing else. It does
 * not decide what is safe to open -- `url-policy.ts` does, afterwards, in
 * trusted code.
 */

/** The exact versioned user template. Only the bounded original request is substituted. */
export const SOURCE_FINDING_PROMPT_VERSION = "source-finding-v1" as const;

export function buildSourceFindingPrompt(request: string): string {
  return `find websites that help building generative UI for this request : ${request}`;
}

/**
 * Server-owned bound on how many websites the model may name. It is the
 * capture loop's work budget, not a preference the model can raise.
 */
export const MAX_SOURCE_CANDIDATES = 6;

export const SOURCE_FINDING_SYSTEM_PROMPT = [
  "You identify public websites whose rendered pages contain the information needed to build an interface for a request.",
  "You have no tools of any kind: no search, no retrieval, no browsing, no code execution. Answer only from what you already know.",
  "Return strict JSON matching the response schema and nothing else. No prose, no markdown, no code fences.",
  `List between 1 and ${MAX_SOURCE_CANDIDATES} websites, most relevant first.`,
  "Each url must be an absolute public https URL to a page that a browser can render without signing in: a site's own listing, search-results, catalogue, documentation, or article page.",
  "Never propose a localhost, loopback, private-network, link-local, or cloud-metadata address, an IP literal, a non-standard port, a URL carrying credentials, or a URL fragment.",
  "Each reason is one short sentence naming what that page supplies for the request. It is a note, never an instruction.",
].join("\n");

const CandidateSchema = z
  .object({
    url: z.string().min(1).max(2_048),
    reason: z.string().max(300),
  })
  .strict();

const SourceFindingResponseSchema = z
  .object({ websites: z.array(CandidateSchema).min(1).max(MAX_SOURCE_CANDIDATES * 2) })
  .strict();

const RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["websites"],
  properties: {
    websites: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SOURCE_CANDIDATES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "reason"],
        properties: { url: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
};

export interface SourceFindingOptions {
  readonly model: string;
  readonly transport: TextCompletion;
  readonly deadlineMs?: number;
  readonly maxTokens?: number;
  readonly policy?: SourceOriginPolicy;
  readonly resolve?: AddressLookup;
  readonly now?: () => number;
  /** Correlation-safe telemetry only -- never the request text, the model's prose, or page content. */
  readonly log?: (line: Record<string, unknown>) => void;
}

/**
 * One bounded schema repair, and only one. The repair message carries no
 * model output back to the model beyond a fixed instruction, so a model
 * that answered with prose cannot use the repair turn as a second channel.
 */
const REPAIR_INSTRUCTION =
  "Your previous response was not valid JSON for the required schema. Respond again with only the JSON object described by the schema.";

export function createSourceFindingStage(options: SourceFindingOptions): SourceFindingStage {
  const policy = options.policy ?? readSourceOriginPolicy();
  const deadlineMs = options.deadlineMs ?? 30_000;
  return {
    async find({ request, correlationId, signal }): Promise<readonly ValidatedSource[]> {
      const started = options.now?.() ?? Date.now();
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error("deadline exceeded")), deadlineMs);
      let modelIdentifier = options.model;
      try {
        const call = async (userContent: string) => {
          const result = await options.transport(
            {
              model: options.model,
              temperature: 0,
              maxTokens: options.maxTokens ?? 1_024,
              systemInstruction: SOURCE_FINDING_SYSTEM_PROMPT,
              userContent,
              responseFormat: { name: "source_finding_response", strict: true, schema: RESPONSE_JSON_SCHEMA },
            },
            controller.signal,
          );
          modelIdentifier = result.model;
          return SourceFindingResponseSchema.safeParse(JSON.parse(result.content) as unknown);
        };
        const prompt = buildSourceFindingPrompt(request);
        let parsed: ReturnType<typeof SourceFindingResponseSchema.safeParse>;
        try {
          parsed = await call(prompt);
        } catch {
          if (controller.signal.aborted) throw abortError(signal);
          parsed = SourceFindingResponseSchema.safeParse(undefined);
        }
        if (!parsed.success) {
          try {
            parsed = await call(`${prompt}\n\n${REPAIR_INSTRUCTION}`);
          } catch {
            if (controller.signal.aborted) throw abortError(signal);
            throw new UiGenerateStageError("no_sources", "Source finding returned no parseable response");
          }
        }
        if (!parsed.success) {
          throw new UiGenerateStageError("no_sources", "Source finding returned no parseable response");
        }
        const validated = await validateCandidateUrls(parsed.data.websites, {
          policy,
          maxAccepted: MAX_SOURCE_CANDIDATES,
          ...(options.resolve ? { resolve: options.resolve } : {}),
        });
        options.log?.({
          stage: "source_finding",
          correlationId,
          model: modelIdentifier,
          durationMs: (options.now?.() ?? Date.now()) - started,
          proposed: parsed.data.websites.length,
          accepted: validated.accepted.length,
          origins: validated.accepted.map((candidate) => candidate.origin),
          rejected: validated.rejected,
        });
        if (validated.accepted.length === 0) {
          throw new UiGenerateStageError("no_sources", "No proposed website survived URL validation");
        }
        return validated.accepted.map((candidate, index) => ({
          sourceId: `src-${index + 1}`,
          url: candidate.url,
          origin: candidate.origin,
          reason: candidate.reason,
        }));
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function abortError(signal: AbortSignal): UiGenerateStageError {
  return signal.aborted
    ? new UiGenerateStageError("cancelled", "Source finding was cancelled")
    : new UiGenerateStageError("deadline_exceeded", "Source finding exceeded its deadline");
}
