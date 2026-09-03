import "server-only";

import { z } from "zod";
import { ModelProviderError, type TextCompletion } from "../../ai/types";
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
 * The model is given hosted web search, no custom tools or conversation
 * history, and temperature zero. It returns strict JSON and nothing else. It does
 * not decide what is safe to open -- `url-policy.ts` does, afterwards, in
 * trusted code.
 */

/** The exact versioned user template. Only the bounded original request is substituted. */
export const SOURCE_FINDING_PROMPT_VERSION = "source-finding-v3" as const;

export function buildSourceFindingPrompt(request: string): string {
  return [
    "Find public web pages containing the specific facts and entities needed to answer this request.",
    "The eventual interface is not part of the research topic. Research only the requested subject matter.",
    "USER REQUEST:",
    request,
  ].join("\n");
}

/**
 * Server-owned bound on how many websites the model may name. It is the
 * capture loop's work budget, not a preference the model can raise.
 */
export const MAX_SOURCE_CANDIDATES = 6;

export const SOURCE_FINDING_SYSTEM_PROMPT = [
  "You identify public pages whose rendered content supplies the evidence needed to answer a user's request.",
  "Use the provided Google Search tool to discover current, specific pages. Search more than once when needed to satisfy every constraint; do not answer from memory when results can be verified.",
  "Inspect search results for relevance before selecting URLs. Prefer the smallest set of pages that collectively contains enough concrete records and details for the requested interface.",
  "Return strict JSON matching the response schema and nothing else. No prose, no markdown, no code fences.",
  `List between 1 and ${MAX_SOURCE_CANDIDATES} websites, most relevant first.`,
  "Research only the subject of the request. Words such as generate, UI, interface, display, dashboard, or compare describe the desired presentation; they are never research subjects.",
  "Never return UI generators, design systems, component libraries, templates, developer documentation, or design-inspiration sites unless the user explicitly asks about those products themselves.",
  "Each URL must be an absolute public HTTPS URL to rendered evidence: a specific listing, a suitably filtered search-results page, a product/result page, a catalogue, or an article.",
  "Prefer deep links over homepages. A homepage is invalid when it does not itself contain the requested records or facts.",
  "Preserve every material constraint from the request in the selected page or URL, including entity type, location, dates, availability window, quantity, category, and filters.",
  "For availability or booking requests, use result/listing URLs that encode the requested location and exact check-in/check-out dates when the site supports such URLs. Do not claim current availability from an unfiltered homepage.",
  "Return multiple distinct result or listing pages when the request needs multiple comparable entities and one results page will not expose enough detail.",
  "Return the canonical destination URL on the site that holds the evidence. Never return a search-engine result, redirect, or click-tracking URL: no vertexaisearch.cloud.google.com grounding redirect, no google.com/url or news.google.com wrapper, no bing.com redirect. If a search result shows one of these, resolve it to the real page URL and return that instead.",
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
  .object({ websites: z.array(CandidateSchema).min(1).max(MAX_SOURCE_CANDIDATES) })
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
  readonly maxTokens?: number;
  readonly policy?: SourceOriginPolicy;
  readonly resolve?: AddressLookup;
  readonly now?: () => number;
  /**
   * Operational telemetry only -- never the raw request text, the model's
   * reason prose, or page content. The policy-validated destination URLs the
   * stage accepts are logged so an operator can see exactly what was opened.
   */
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
  return {
    async find({ request, signal }): Promise<readonly ValidatedSource[]> {
      const started = options.now?.() ?? Date.now();
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      let modelIdentifier = options.model;
      let proposed = 0;
      let acceptedOrigins: readonly string[] = [];
      let acceptedUrls: readonly string[] = [];
      try {
        const call = async (userContent: string) => {
          const result = await abortableCompletion(options.transport(
            {
              model: options.model,
              temperature: 0,
              maxTokens: options.maxTokens ?? 1_024,
              systemInstruction: SOURCE_FINDING_SYSTEM_PROMPT,
              userContent,
              hostedTools: ["web_search"],
              responseFormat: { name: "source_finding_response", strict: true, schema: RESPONSE_JSON_SCHEMA },
            },
            controller.signal,
          ), controller.signal);
          modelIdentifier = result.model;
          return SourceFindingResponseSchema.safeParse(JSON.parse(result.content) as unknown);
        };
        const prompt = buildSourceFindingPrompt(request);
        let parsed: ReturnType<typeof SourceFindingResponseSchema.safeParse>;
        // A SyntaxError (unparseable JSON), a schema miss, or a transient
        // provider failure (a malformed/empty candidate, a 5xx that survived
        // the transport's own retries) all get the one repair turn below. A
        // 4xx that names a real problem with this request does not.
        const isRepairable = (error: unknown): boolean =>
          error instanceof SyntaxError ||
          (error instanceof ModelProviderError &&
            (error.code === "AI_MALFORMED_RESPONSE" ||
              error.code === "AI_RATE_LIMITED" ||
              error.code === "AI_PROVIDER_UNAVAILABLE" ||
              error.code === "AI_TIMEOUT"));
        try {
          parsed = await call(prompt);
        } catch (error) {
          if (controller.signal.aborted) throw abortError();
          if (!isRepairable(error)) {
            throw new UiGenerateStageError("no_sources", "Source finding request failed", { cause: error });
          }
          parsed = SourceFindingResponseSchema.safeParse(undefined);
        }
        if (!parsed.success) {
          try {
            parsed = await call(`${prompt}\n\n${REPAIR_INSTRUCTION}`);
          } catch (error) {
            if (controller.signal.aborted) throw abortError();
            throw new UiGenerateStageError("no_sources", "Source finding returned no parseable response", { cause: error });
          }
        }
        if (!parsed.success) {
          throw new UiGenerateStageError("no_sources", "Source finding returned no parseable response");
        }
        proposed = parsed.data.websites.length;
        let validated;
        try {
          validated = await validateCandidateUrls(parsed.data.websites, {
            policy,
            maxAccepted: MAX_SOURCE_CANDIDATES,
            signal: controller.signal,
            ...(options.resolve ? { resolve: options.resolve } : {}),
          });
        } catch (error) {
          if (controller.signal.aborted) throw abortError();
          throw error;
        }
        acceptedOrigins = validated.accepted.map((candidate) => candidate.origin);
        acceptedUrls = validated.accepted.map((candidate) => candidate.url);
        if (validated.accepted.length === 0) {
          throw new UiGenerateStageError("no_sources", "No proposed website survived URL validation");
        }
        options.log?.({
          stage: "source_finding",
          model: modelIdentifier,
          durationMs: (options.now?.() ?? Date.now()) - started,
          proposed,
          accepted: validated.accepted.length,
          origins: acceptedOrigins,
          urls: acceptedUrls,
          rejected: validated.rejected,
        });
        return validated.accepted.map((candidate, index) => ({
          sourceId: `src-${index + 1}`,
          url: candidate.url,
          origin: candidate.origin,
          reason: candidate.reason,
        }));
      } catch (error) {
        const category = error instanceof UiGenerateStageError ? error.category : "no_sources";
        options.log?.({
          stage: "source_finding",
          model: modelIdentifier,
          durationMs: (options.now?.() ?? Date.now()) - started,
          proposed,
          accepted: acceptedOrigins.length,
          origins: acceptedOrigins,
          urls: acceptedUrls,
          errorCategory: category,
        });
        throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function abortableCompletion<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortError(): UiGenerateStageError {
  return new UiGenerateStageError("cancelled", "Source finding was cancelled");
}
