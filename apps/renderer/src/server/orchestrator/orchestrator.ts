import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  CONTRACT_MAJOR_VERSION,
  EXPLORE_WEBSITE_TOOL_NAME,
  ExploreWebsiteDocumentSchema,
  ExploreWebsiteSuccessResultSchema,
  GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME,
  NAVIGATE_AND_EXTRACT_TOOL_NAME,
  NavigateAndExtractSuccessResultSchema,
  type Citation,
  type EvidenceChunk,
  type Source,
  type ToolErrorResult,
  type GenerativeUiPlan,
  type PageUnderstanding,
} from "@ai-browser/contracts";
import { z } from "zod";
import type { MistralAdapter, MistralConversationTurn } from "../ai/mistral";
import {
  assistantTextPart,
  selectConversationContext,
  toolResultPart,
  userTextPart,
  type ConversationMessage,
  type ConversationRepository,
} from "../conversation";
import {
  CitationMarkerScanner,
  computeQuoteHash,
  resolveCitations,
  type CitationMarkerOccurrence,
  type EvidenceBundle,
  type MarkerScanResult,
} from "../citations";
import type { RegisteredTool } from "./registry";
import { classifyRoute, findExplicitSafeUrl, type RoutingDecision, type RoutingRoute } from "./routing";
import { OrchestratorError, type OrchestratorCitationSource, type OrchestratorEvent, type OrchestratorState } from "./types";
import type { GeneratedUiReference } from "../generative-ui";

/** Correlation-safe routing telemetry (P02-F05 step 5) -- never carries the request text or page content. */
export interface RouteDecisionMetric {
  correlationId: string;
  route: RoutingRoute | "failed";
  usedDiscovery: boolean;
}

export interface OrchestratorOptions {
  model: MistralAdapter;
  conversations: ConversationRepository;
  tools: ReadonlyMap<string, RegisteredTool>;
  maxSteps?: number;
  deadlineMs?: number;
  maxMessages?: number;
  maxEstimatedTokens?: number;
  createId?: () => string;
  emitRouteDecision?: (metric: RouteDecisionMetric) => void;
  generateUi?: (input: { ownerId: string; task: string; plan: GenerativeUiPlan; pageUnderstanding: PageUnderstanding; signal: AbortSignal }) => Promise<GeneratedUiReference | null>;
}

/**
 * Resolves the request-scoped tool surface for a routing decision (P02-F05
 * steps 2-5). Only gates the browsing-specific surface -- `web_search`
 * (hosted) and `browser.navigate_and_extract` -- and leaves any other
 * registered tool (e.g. Phase 1's `system.echo`) untouched, since this
 * repair's routing concern is research-vs-browsing, not the whole registry:
 * `web_search_only` never sees the browsing tool, `website_read_required`
 * keeps whatever else is registered plus the browsing tool, and
 * `web_search` (hosted) is only offered when discovery is actually needed --
 * i.e. not when the user already supplied an explicit safe URL to read.
 * `code_interpreter`/`image_generation` are never enabled by this flow.
 *
 * Always returns a fresh, request-scoped `Map` copy (never `tools` itself)
 * so per-run tool-surface changes never leak into the shared,
 * constructor-supplied registry other runs and other sessions also read
 * from.
 */
function resolveRouteTools(
  route: RoutingRoute,
  explicitUrl: string | undefined,
  tools: ReadonlyMap<string, RegisteredTool>,
): { routeTools: Map<string, RegisteredTool>; hostedTools: readonly "web_search"[]; usedDiscovery: boolean } {
  const routeTools = new Map(tools);
  if (route === "web_search_only") {
    routeTools.delete(NAVIGATE_AND_EXTRACT_TOOL_NAME);
    routeTools.delete(EXPLORE_WEBSITE_TOOL_NAME);
    routeTools.delete(GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME);
    return { routeTools, hostedTools: ["web_search"], usedDiscovery: false };
  }
  const usedDiscovery = explicitUrl === undefined;
  return { routeTools, hostedTools: usedDiscovery ? ["web_search"] : [], usedDiscovery };
}

export interface RunConversationInput {
  sessionId: string;
  ownerId: string;
  text: string;
  signal?: AbortSignal;
}

interface PendingCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

const InputSchema = z.object({
  sessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  ownerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  text: z.string().trim().min(1).max(32_000),
}).strict();

function toModelTurn(message: ConversationMessage): MistralConversationTurn {
  const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  const result = message.parts.find((part) => part.type === "tool-result");
  if (message.role === "tool" && result?.type === "tool-result") {
    return { role: "tool", content: JSON.stringify(result.result), toolCallId: result.invocationId, name: result.toolName };
  }
  return { role: message.role, content: text };
}

/**
 * A `browser.navigate_and_extract` result's own `chunk-0`, `chunk-1`, ...
 * ids (see `chunking.py`) are minted independently per document, so two
 * calls in the same turn can mint the identical id for unrelated chunks.
 * The model only ever echoes back a `chunkId` it read verbatim from a
 * tool result (see `server/conversation/instructions.ts`), so this
 * rewrites every `chunkId` in the result -- and every warning/truncation
 * that references one -- to be namespaced by `toolCallId` *before* the
 * result is ever serialized into the model's turns. That makes the id the
 * model later cites already globally unique for this turn, with no change
 * needed to the `[[cite:...]]` marker syntax or the resolver. Returns
 * `result` unchanged for any other tool, or an error/malformed result.
 */
function namespaceEvidenceChunkIds(toolCallId: string, toolName: string, result: unknown): unknown {
  const parsed = toolName === NAVIGATE_AND_EXTRACT_TOOL_NAME
    ? NavigateAndExtractSuccessResultSchema.safeParse(result)
    : toolName === EXPLORE_WEBSITE_TOOL_NAME ? ExploreWebsiteSuccessResultSchema.safeParse(result) : null;
  if (!parsed?.success) return result;
  if (!parsed.success) return result;
  const prefix = createHash("sha256").update(toolCallId, "utf8").digest("hex").slice(0, 8);
  const rawDocument = toolName === EXPLORE_WEBSITE_TOOL_NAME
    ? (parsed.data.payload as { document: Record<string, unknown> }).document
    : parsed.data.payload as Record<string, unknown>;
  const document = ExploreWebsiteDocumentSchema.parse({ metadata: rawDocument.metadata, chunks: rawDocument.chunks, warnings: rawDocument.warnings, truncations: rawDocument.truncations });
  const renamed = new Map(document.chunks.map((chunk) => [chunk.chunkId, `${prefix}-${chunk.chunkId}`]));
  const renamedDocument = {
    ...document,
    chunks: document.chunks.map((chunk) => ({ ...chunk, chunkId: renamed.get(chunk.chunkId)! })),
    warnings: document.warnings.map((warning) => warning.chunkId && renamed.has(warning.chunkId) ? { ...warning, chunkId: renamed.get(warning.chunkId) } : warning),
    truncations: document.truncations.map((truncation) => truncation.atChunkId && renamed.has(truncation.atChunkId) ? { ...truncation, atChunkId: renamed.get(truncation.atChunkId) } : truncation),
  };
  return {
    ...parsed.data,
    payload: toolName === EXPLORE_WEBSITE_TOOL_NAME
      ? { ...parsed.data.payload, document: renamedDocument }
      : { ...parsed.data.payload, ...renamedDocument },
  };
}

/**
 * Extracts citable evidence from a (already chunk-id-namespaced, see
 * `namespaceEvidenceChunkIds`) `browser.navigate_and_extract` tool result:
 * one `Source` for the page, and one `EvidenceChunk` per returned chunk,
 * keyed by the tool's own `chunkId` -- the exact id the model is
 * instructed to reference via `[[cite:<chunkId>]]` (see
 * `server/conversation/instructions.ts` and `CitationMarkerScanner`'s
 * docstring). Returns `null` for any other tool, or an error/malformed
 * result.
 */
function extractEvidenceFromToolResult(
  toolCallId: string,
  toolName: string,
  result: unknown,
): { source: Source; chunks: EvidenceChunk[] } | null {
  const parsed = toolName === NAVIGATE_AND_EXTRACT_TOOL_NAME
    ? NavigateAndExtractSuccessResultSchema.safeParse(result)
    : toolName === EXPLORE_WEBSITE_TOOL_NAME ? ExploreWebsiteSuccessResultSchema.safeParse(result) : null;
  if (!parsed?.success) return null;
  const rawDocument = toolName === EXPLORE_WEBSITE_TOOL_NAME
    ? (parsed.data.payload as { document: Record<string, unknown> }).document
    : parsed.data.payload as Record<string, unknown>;
  const { metadata, chunks } = ExploreWebsiteDocumentSchema.parse({ metadata: rawDocument.metadata, chunks: rawDocument.chunks, warnings: rawDocument.warnings, truncations: rawDocument.truncations });
  const source: Source = {
    id: `source-${toolCallId}`,
    url: metadata.url,
    title: metadata.title,
    retrievedAt: new Date().toISOString(),
  };
  const evidenceChunks: EvidenceChunk[] = chunks.map((chunk) => ({
    id: chunk.chunkId,
    sourceId: source.id,
    text: chunk.text,
  }));
  return { source, chunks: evidenceChunks };
}

function errorResult(requestId: string, userId: string, callId: string, code: ToolErrorResult["errorCode"], message: string, retryable: boolean): ToolErrorResult {
  return {
    contractVersion: CONTRACT_MAJOR_VERSION,
    correlation: { requestId, userId },
    toolCallId: callId,
    status: "error",
    errorCode: code,
    message,
    retryable,
  };
}

export class ChatOrchestrator {
  private readonly maxSteps: number;
  private readonly deadlineMs: number;
  private readonly maxMessages: number;
  private readonly maxEstimatedTokens: number;
  private readonly createId: () => string;

  constructor(private readonly options: OrchestratorOptions) {
    this.maxSteps = options.maxSteps ?? 6;
    this.deadlineMs = options.deadlineMs ?? 60_000;
    this.maxMessages = options.maxMessages ?? 50;
    this.maxEstimatedTokens = options.maxEstimatedTokens ?? 16_000;
    this.createId = options.createId ?? randomUUID;
  }

  async *run(rawInput: RunConversationInput): AsyncGenerator<OrchestratorEvent> {
    const parsed = InputSchema.parse({ sessionId: rawInput.sessionId, ownerId: rawInput.ownerId, text: rawInput.text });
    const requestId = this.createId();
    const release = this.options.conversations.acquireRequest(parsed.sessionId, parsed.ownerId, requestId);
    const deadlineSignal = AbortSignal.timeout(this.deadlineMs);
    const signal = rawInput.signal ? AbortSignal.any([rawInput.signal, deadlineSignal]) : deadlineSignal;
    const prior = this.options.conversations.read(parsed.sessionId, parsed.ownerId);
    const selected = selectConversationContext(prior, { maxMessages: this.maxMessages, maxEstimatedTokens: this.maxEstimatedTokens });
    const modelTurns: MistralConversationTurn[] = [
      ...selected.messages.map(toModelTurn),
      { role: "user", content: parsed.text },
    ];
    const committedTools: Array<{ name: string; id: string; result: unknown }> = [];
    const callFingerprints = new Set<string>();
    let finalText = "";
    let state: OrchestratorState = "model-request";
    const createId = this.createId;
    const evidenceSources = new Map<string, Source>();
    const evidenceChunks = new Map<string, EvidenceChunk>();
    const citedSources = new Map<string, OrchestratorCitationSource>();
    const markerScanner = new CitationMarkerScanner();

    function* emitScannedText(scanned: MarkerScanResult, appendTo: (text: string) => void): Generator<OrchestratorEvent> {
      if (scanned.clean.length > 0) {
        appendTo(scanned.clean);
        yield { type: "text-delta", delta: scanned.clean };
      }
      for (const marker of scanned.markers) {
        const resolved = resolveMarker(marker);
        if (!resolved) continue;
        citedSources.set(resolved.source.id, resolved.source);
        yield {
          type: "citation-marker",
          id: createId(),
          citationId: resolved.citation.id,
          sourceId: resolved.source.id,
          position: marker.position,
        };
      }
    }

    function resolveMarker(marker: CitationMarkerOccurrence): { source: Source; citation: Citation } | null {
      const chunk = evidenceChunks.get(marker.chunkId);
      if (!chunk) return null;
      const source = evidenceSources.get(chunk.sourceId);
      if (!source) return null;
      const citation: Citation = {
        id: createId(),
        sourceId: chunk.sourceId,
        chunkId: chunk.id,
        locator: { kind: "quoteHash", hash: computeQuoteHash(chunk.text) },
      };
      const evidence: EvidenceBundle = { sources: [...evidenceSources.values()], chunks: [...evidenceChunks.values()] };
      const resolution = resolveCitations(evidence, [citation]);
      return resolution.valid.length === 1 ? { source, citation } : null;
    }

    try {
      let decision: RoutingDecision;
      try {
        decision = await classifyRoute(this.options.model, { correlationId: requestId, text: parsed.text, signal });
      } catch {
        if (signal.aborted) throw new OrchestratorError(deadlineSignal.aborted ? "DEADLINE" : "CANCELLED", deadlineSignal.aborted ? "The request deadline was reached." : "The request was stopped.");
        this.options.emitRouteDecision?.({ correlationId: requestId, route: "failed", usedDiscovery: false });
        throw new OrchestratorError("ROUTING_FAILED", "The assistant could not classify this request safely. Please try again.");
      }
      const explicitUrl = decision.route === "website_read_required" ? findExplicitSafeUrl(parsed.text) : undefined;
      const { routeTools, hostedTools, usedDiscovery } = resolveRouteTools(decision.route, explicitUrl, this.options.tools);
      this.options.emitRouteDecision?.({ correlationId: requestId, route: decision.route, usedDiscovery });

      for (let step = 0; step < this.maxSteps; step += 1) {
        if (signal.aborted) throw new OrchestratorError(deadlineSignal.aborted ? "DEADLINE" : "CANCELLED", deadlineSignal.aborted ? "The request deadline was reached." : "The request was stopped.");
        state = "model-request";
        const calls = new Map<number, PendingCall>();
        let stepText = "";
        for await (const event of this.options.model.stream({
          correlationId: requestId,
          systemInstruction: selected.systemInstruction,
          turns: modelTurns,
          tools: [...routeTools.values()].map((tool) => tool.definition),
          hostedTools,
          signal,
        })) {
          if (event.type === "text-delta") {
            const scanned = markerScanner.push(event.text);
            yield* emitScannedText(scanned, (text) => {
              stepText += text;
              finalText += text;
            });
          } else if (event.type === "hosted-tool-status") {
            yield { type: "tool-status", id: event.id, label: event.name.replaceAll("_", " "), state: event.state };
          } else if (event.type === "artifact") {
            yield {
              type: "artifact",
              id: this.createId(),
              artifactType: event.artifactType,
              title: event.title,
              url: event.fileId ? `/api/mistral/files/${encodeURIComponent(event.fileId)}` : event.url,
              mediaType: event.mediaType,
            };
          } else if (event.type === "tool-call-delta") {
            const existing = calls.get(event.index) ?? { index: event.index, id: event.id ?? this.createId(), name: event.name ?? "", arguments: "" };
            if (event.id) existing.id = event.id;
            if (event.name) existing.name = event.name;
            existing.arguments += event.argumentsDelta;
            calls.set(event.index, existing);
          }
        }
        if (calls.size === 0) {
          const flushed = markerScanner.flush();
          yield* emitScannedText(flushed, (text) => {
            stepText += text;
            finalText += text;
          });
          state = "final-response";
          break;
        }
        const orderedCalls = [...calls.values()].sort((a, b) => a.index - b.index);
        modelTurns.push({
          role: "assistant",
          content: stepText,
          toolCalls: orderedCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
        });
        for (const call of orderedCalls) {
          state = "tool-validation";
          const tool = routeTools.get(call.name);
          if (!tool) throw new OrchestratorError("UNKNOWN_TOOL", "The model requested a tool that is not available.");
          const fingerprint = `${call.name}:${call.arguments}`;
          const isRepeat = callFingerprints.has(fingerprint);
          callFingerprints.add(fingerprint);
          let result: unknown;
          if (isRepeat) {
            // The model re-issued a call it already made (with identical arguments) earlier in
            // this turn. Re-running it would just repeat work and risks looping forever, so this
            // is answered with a synthetic, non-retryable error instead of re-executing the tool --
            // the step cap (`maxSteps`) remains the backstop against genuine runaway loops.
            result = errorResult(requestId, parsed.ownerId, call.id, "INTERNAL", "This exact tool call was already made earlier in this turn. Reuse that result instead of repeating it.", false);
            yield { type: "tool-status", id: call.id, label: call.name, state: "failed" };
          } else {
            try {
              const json = JSON.parse(call.arguments);
              const args = tool.parseArguments(json);
              state = "tool-execution";
              yield { type: "tool-status", id: call.id, label: call.name, state: "running" };
              result = await tool.execute(args, { requestId, userId: parsed.ownerId, sessionId: parsed.sessionId, invocationId: call.id, signal });
              yield { type: "tool-status", id: call.id, label: call.name, state: "completed" };
            } catch (error) {
              if (signal.aborted) throw new OrchestratorError(deadlineSignal.aborted ? "DEADLINE" : "CANCELLED", "The tool call was stopped.");
              const invalid = error instanceof SyntaxError || error instanceof z.ZodError;
              result = errorResult(requestId, parsed.ownerId, call.id, invalid ? "INVALID_ARGUMENTS" : "INTERNAL", invalid ? "The tool arguments were invalid." : "The tool could not complete safely.", !invalid);
              yield { type: "tool-status", id: call.id, label: call.name, state: "failed" };
            }
          }
          state = "result-append";
          result = namespaceEvidenceChunkIds(call.id, call.name, result);
          committedTools.push({ name: call.name, id: call.id, result });
          if (call.name === "ui.propose_generative_ui_plan" && this.options.generateUi) {
            const exploration = [...committedTools].reverse().find((item) => item.name === EXPLORE_WEBSITE_TOOL_NAME);
            const parsedExploration = exploration ? ExploreWebsiteSuccessResultSchema.safeParse(exploration.result) : null;
            try {
              const plan = JSON.parse(call.arguments) as GenerativeUiPlan;
              if (parsedExploration?.success && parsedExploration.data.status === "success") {
                const reference = await this.options.generateUi({ ownerId: parsed.ownerId, task: parsed.text, plan, pageUnderstanding: parsedExploration.data.payload.pageUnderstanding, signal });
                if (reference) yield { type: "generated-ui", id: this.createId(), ...reference };
              }
            } catch {
            }
          }
          const evidence = extractEvidenceFromToolResult(call.id, call.name, result);
          if (evidence) {
            evidenceSources.set(evidence.source.id, evidence.source);
            for (const chunk of evidence.chunks) evidenceChunks.set(chunk.id, chunk);
          }
          modelTurns.push({ role: "tool", content: JSON.stringify(result), toolCallId: call.id, name: call.name });
        }
        if (step === this.maxSteps - 1) throw new OrchestratorError("STEP_LIMIT", "The tool loop reached its step limit.");
      }
      if (state !== "final-response") throw new OrchestratorError("STEP_LIMIT", "The tool loop reached its step limit.");
      this.options.conversations.append(parsed.sessionId, parsed.ownerId, { role: "user", parts: [userTextPart(parsed.text)], correlationId: requestId }, "client");
      for (const tool of committedTools) {
        this.options.conversations.append(parsed.sessionId, parsed.ownerId, { role: "tool", parts: [toolResultPart(tool.name, tool.id, tool.result)], correlationId: requestId }, "server");
      }
      this.options.conversations.append(parsed.sessionId, parsed.ownerId, { role: "assistant", parts: [assistantTextPart(finalText || "Completed.")], correlationId: requestId, completeTurn: true }, "server");
      if (citedSources.size > 0) {
        yield { type: "citation-sources", id: createId(), sources: [...citedSources.values()] };
      }
      state = "completed";
      yield { type: "done" };
    } finally {
      release();
      void state;
    }
  }
}
