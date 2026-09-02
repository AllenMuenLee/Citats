import "server-only";

import { randomUUID } from "node:crypto";
import { UI_GENERATE_TOOL_NAME, type UiGenerateProgressState } from "@ai-browser/contracts";
import { z } from "zod";
import type { ModelAdapter, ConversationTurn } from "../ai";
import {
  assistantTextPart,
  selectConversationContext,
  toolResultPart,
  userTextPart,
  type ConversationMessage,
  type ConversationRepository,
} from "../conversation";
import type { RegisteredTool } from "./registry";
import { OrchestratorError, type GeneratedViewEvent, type OrchestratorEvent, type OrchestratorState } from "./types";

/**
 * The conversation loop (P02-F02).
 *
 * What it does is now almost all of what it *doesn't* do: there is no route
 * classifier, no discovery pass, no exploration directive, no observation
 * digest, no UI-intent regex, and no path that produces a generated view
 * without the model having called `ui.generate`. A turn is: send the
 * history plus the one tool, take either text or that one call, run it, and
 * let the model answer.
 */
export interface OrchestratorOptions {
  model: ModelAdapter;
  conversations: ConversationRepository;
  tools: ReadonlyMap<string, RegisteredTool>;
  maxSteps?: number;
  deadlineMs?: number;
  maxMessages?: number;
  maxEstimatedTokens?: number;
  createId?: () => string;
  /** Developer-only trace of the loop's own decisions. Unset, nothing is traced. */
  trace?: (event: string, detail: Record<string, unknown>) => void;
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
  /** Opaque provider token replayed with this call -- see `ModelToolCallDelta.signature`. */
  signature?: string;
}

/**
 * How many times in a row a step may come back with neither a tool call nor
 * any user-visible text before the turn is failed rather than nudged again.
 * One retry distinguishes a model that lost the thread from one that cannot
 * answer at all; the step cap remains the backstop.
 */
const MAX_CONSECUTIVE_EMPTY_RESPONSES = 2;

const InputSchema = z
  .object({
    sessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    ownerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    text: z.string().trim().min(1).max(32_000),
  })
  .strict();

function toModelTurn(message: ConversationMessage): ConversationTurn {
  const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  const result = message.parts.find((part) => part.type === "tool-result");
  if (message.role === "tool" && result?.type === "tool-result") {
    return { role: "tool", content: JSON.stringify(result.result), toolCallId: result.invocationId, name: result.toolName };
  }
  return { role: message.role, content: text };
}

const PROGRESS_LABELS: Readonly<Record<UiGenerateProgressState, string>> = Object.freeze({
  source_finding: "Finding sources",
  page_capture: "Reading pages",
  ui_planning: "Planning the interface",
  ui_generation: "Generating the interface",
  validation: "Validating",
  rendering: "Rendering",
});

export class ChatOrchestrator {
  private readonly maxSteps: number;
  /** No default: an overall time budget is opt-in only, so a turn ends when the model finishes, `maxSteps` is hit, or the user stops it. */
  private readonly deadlineMs: number | undefined;
  private readonly maxMessages: number;
  private readonly maxEstimatedTokens: number;
  private readonly createId: () => string;

  constructor(private readonly options: OrchestratorOptions) {
    // Two steps is the whole shape of a turn now: at most one tool call,
    // then the answer that reports it.
    this.maxSteps = options.maxSteps ?? 3;
    this.deadlineMs = options.deadlineMs;
    this.maxMessages = options.maxMessages ?? 50;
    this.maxEstimatedTokens = options.maxEstimatedTokens ?? 16_000;
    this.createId = options.createId ?? randomUUID;
  }

  async *run(rawInput: RunConversationInput): AsyncGenerator<OrchestratorEvent> {
    const parsed = InputSchema.parse({ sessionId: rawInput.sessionId, ownerId: rawInput.ownerId, text: rawInput.text });
    const requestId = this.createId();
    const release = this.options.conversations.acquireRequest(parsed.sessionId, parsed.ownerId, requestId);
    const deadlineSignal = this.deadlineMs !== undefined ? AbortSignal.timeout(this.deadlineMs) : undefined;
    const callerAndDeadline = [rawInput.signal, deadlineSignal].filter((candidate): candidate is AbortSignal => candidate !== undefined);
    const signal = callerAndDeadline.length > 0 ? AbortSignal.any(callerAndDeadline) : new AbortController().signal;
    const abortError = () =>
      deadlineSignal?.aborted
        ? new OrchestratorError("DEADLINE", "The request deadline was reached.")
        : new OrchestratorError("CANCELLED", "The request was stopped.");
    const prior = this.options.conversations.read(parsed.sessionId, parsed.ownerId);
    const selected = selectConversationContext(prior, { maxMessages: this.maxMessages, maxEstimatedTokens: this.maxEstimatedTokens });
    const modelTurns: ConversationTurn[] = [...selected.messages.map(toModelTurn), { role: "user", content: parsed.text }];
    const committedTools: Array<{ name: string; id: string; result: unknown }> = [];
    let finalText = "";
    let consecutiveEmptyResponses = 0;
    let state: OrchestratorState = "model-request";
    /** One `ui.generate` execution per turn, enforced here rather than trusted to the model. */
    let uiGenerateCalls = 0;
    const traceSink = this.options.trace;
    const trace = (event: string, detail: Record<string, unknown>): void => traceSink?.(event, { requestId, ...detail });
    // Events the tool produces while it runs are buffered here and drained
    // by the generator, because a tool executes inside an `await` and cannot
    // yield from the generator itself.
    const pending: OrchestratorEvent[] = [];

    trace("turn-start", { sessionId: parsed.sessionId, priorMessages: selected.messages.length, maxSteps: this.maxSteps, tools: [...this.options.tools.keys()] });

    try {
      for (let step = 0; step < this.maxSteps; step += 1) {
        if (signal.aborted) throw abortError();
        state = "model-request";
        const calls = new Map<number, PendingCall>();
        let stepText = "";
        // A tool the turn has already spent is withheld from later steps, so
        // "once per turn" is a property of the surface rather than a rule the
        // model is asked to remember.
        const availableTools = [...this.options.tools.values()].filter(
          (tool) => tool.definition.name !== UI_GENERATE_TOOL_NAME || uiGenerateCalls === 0,
        );
        trace("step-start", { step, turns: modelTurns.length, tools: availableTools.map((tool) => tool.definition.name) });

        for await (const event of this.options.model.stream({
          correlationId: requestId,
          systemInstruction: selected.systemInstruction,
          turns: modelTurns,
          tools: availableTools.map((tool) => tool.definition),
          signal,
        })) {
          if (event.type === "text-delta") {
            stepText += event.text;
            finalText += event.text;
            yield { type: "text-delta", delta: event.text };
          } else if (event.type === "tool-call-delta") {
            const existing = calls.get(event.index) ?? { index: event.index, id: event.id ?? this.createId(), name: event.name ?? "", arguments: "" };
            if (event.id) existing.id = event.id;
            if (event.name) existing.name = event.name;
            if (event.signature) existing.signature = event.signature;
            existing.arguments += event.argumentsDelta;
            calls.set(event.index, existing);
          }
        }

        if (calls.size === 0) {
          trace("step-no-tool-calls", { step, textChars: stepText.length });
          if (!stepText.trim()) {
            consecutiveEmptyResponses += 1;
            if (consecutiveEmptyResponses >= MAX_CONSECUTIVE_EMPTY_RESPONSES) {
              throw new OrchestratorError("EMPTY_RESPONSE", "The assistant produced no answer and no tool call. Please try again.");
            }
            modelTurns.push({
              role: "user",
              content: "Your previous response contained no user-visible answer and no tool call. Answer the original request concisely.",
            });
            continue;
          }
          consecutiveEmptyResponses = 0;
          state = "final-response";
          break;
        }

        consecutiveEmptyResponses = 0;
        const orderedCalls = [...calls.values()].sort((a, b) => a.index - b.index);
        trace("step-tool-calls", { step, calls: orderedCalls.map((call) => call.name) });
        modelTurns.push({
          role: "assistant",
          content: stepText,
          toolCalls: orderedCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            ...(call.signature ? { signature: call.signature } : {}),
          })),
        });

        // More than one call in a step is a policy violation, not something
        // to partially honour: only the first is considered, and a duplicate
        // fails the turn closed.
        if (orderedCalls.length > 1) {
          trace("duplicate-tool-calls", { step, count: orderedCalls.length });
          throw new OrchestratorError("REPEATED_TOOL_CALL", "The model requested more than one tool call in a single step.");
        }

        const call = orderedCalls[0]!;
        state = "tool-validation";
        const tool = this.options.tools.get(call.name);
        if (!tool) throw new OrchestratorError("UNKNOWN_TOOL", "The model requested a tool that is not available.");
        if (call.name === UI_GENERATE_TOOL_NAME && uiGenerateCalls > 0) {
          throw new OrchestratorError("REPEATED_TOOL_CALL", "The model called ui.generate more than once in one turn.");
        }

        let result: unknown;
        try {
          const json: unknown = JSON.parse(call.arguments);
          const args = tool.parseArguments(json);
          state = "tool-execution";
          if (call.name === UI_GENERATE_TOOL_NAME) uiGenerateCalls += 1;
          yield { type: "tool-status", id: call.id, label: call.name, state: "running" };
          result = await tool.execute(args, {
            requestId,
            userId: parsed.ownerId,
            sessionId: parsed.sessionId,
            invocationId: call.id,
            signal,
            requestText: parsed.text,
            emitProgress: (progressState) => {
              const label = PROGRESS_LABELS[progressState as UiGenerateProgressState] ?? progressState;
              pending.push({ type: "tool-progress", id: this.createId(), toolCallId: call.id, state: String(progressState), label });
            },
            emitView: (view) => {
              const reference = view as GeneratedViewEvent["view"];
              pending.push({ type: "generated-ui", id: this.createId(), view: reference });
            },
            ...(traceSink ? { trace } : {}),
          });
        } catch (error) {
          if (signal.aborted) throw abortError();
          // A malformed argument payload is a contract failure, not a
          // browsing error: there is nothing to retry against.
          trace("tool-call-invalid", { step, name: call.name, error: error instanceof Error ? error.name : "unknown" });
          throw new OrchestratorError("CONTRACT_ERROR", "The model produced an invalid tool call.");
        }

        // Progress and view events raised during execution are surfaced in
        // the order they happened, before the terminal status.
        while (pending.length > 0) yield pending.shift()!;

        const status = (result as { status?: unknown } | null)?.status;
        yield status === "ready"
          ? { type: "tool-status", id: call.id, label: call.name, state: "completed" }
          : { type: "tool-status", id: call.id, label: call.name, state: "failed", response: String((result as { category?: unknown }).category ?? "failed") };

        state = "result-append";
        trace("tool-result", { step, name: call.name, status: String(status) });
        committedTools.push({ name: call.name, id: call.id, result });
        modelTurns.push({ role: "tool", content: JSON.stringify(result), toolCallId: call.id, name: call.name });

        if (step === this.maxSteps - 1) throw new OrchestratorError("STEP_LIMIT", "The tool loop reached its step limit.");
      }

      if (state !== "final-response") throw new OrchestratorError("STEP_LIMIT", "The tool loop reached its step limit.");

      trace("turn-complete", { finalTextChars: finalText.length, toolCalls: committedTools.map((tool) => tool.name) });
      this.options.conversations.append(parsed.sessionId, parsed.ownerId, { role: "user", parts: [userTextPart(parsed.text)], correlationId: requestId }, "client");
      for (const tool of committedTools) {
        this.options.conversations.append(
          parsed.sessionId,
          parsed.ownerId,
          { role: "tool", parts: [toolResultPart(tool.name, tool.id, tool.result)], correlationId: requestId },
          "server",
        );
      }
      this.options.conversations.append(
        parsed.sessionId,
        parsed.ownerId,
        { role: "assistant", parts: [assistantTextPart(finalText || "Completed.")], correlationId: requestId, completeTurn: true },
        "server",
      );
      state = "completed";
      yield { type: "done" };
    } finally {
      release();
      void state;
    }
  }
}
