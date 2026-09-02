import "server-only";

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type {
  ConversationTurn,
  ModelAdapter,
  ModelStreamEvent,
  ModelStreamRequest,
} from "./types";

/**
 * Developer-only transcript of every model call this app makes.
 *
 * The orchestrator hands each provider an abstract `ModelStreamRequest`
 * (system instruction + the whole turn list + the tool surface for that
 * step) and reads back a stream of abstract events. That pair is exactly
 * what is needed to answer "why did the model stop calling tools?", so the
 * log is taken at that seam rather than at the HTTP layer: it records what
 * the model was actually shown and what it actually replied, for every role
 * (routing, discovery, chat, extraction) and every step of the tool loop.
 *
 * Never records credentials: API keys live in request headers, which this
 * layer does not see, and no header is logged. Page and tool content is
 * recorded verbatim because that is the point of the log -- so it is opt-in
 * (`CHAT_LOG_CONVERSATION=1`), written only to a local file under the
 * developer's own working directory, and must not be enabled for a session
 * whose pages carry anything sensitive.
 */
export interface TranscriptLogConfig {
  enabled: boolean;
  /** Directory the JSONL run files are written to. */
  directory: string;
  /** Mirrors a one-line summary of each entry to the server console. */
  console: boolean;
  /** Per-field cap so one page capture cannot make the log unreadable. `0` disables truncation. */
  maxFieldChars: number;
}

const DEFAULT_DIRECTORY = ".ai-logs";
const DEFAULT_MAX_FIELD_CHARS = 20_000;

export function readTranscriptLogConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TranscriptLogConfig {
  const parsedMax = Number(environment.CHAT_LOG_CONVERSATION_MAX_CHARS ?? DEFAULT_MAX_FIELD_CHARS);
  return {
    enabled: environment.CHAT_LOG_CONVERSATION === "1",
    directory: environment.CHAT_LOG_CONVERSATION_DIR?.trim() || DEFAULT_DIRECTORY,
    console: environment.CHAT_LOG_CONVERSATION_CONSOLE !== "0",
    maxFieldChars: Number.isFinite(parsedMax) && parsedMax >= 0 ? Math.floor(parsedMax) : DEFAULT_MAX_FIELD_CHARS,
  };
}

export interface LoggedTurn {
  role: ConversationTurn["role"];
  name?: string;
  toolCallId?: string;
  content: string;
  toolCalls?: readonly { id: string; name: string; arguments: string; signed?: boolean }[];
}

export interface LoggedToolCall {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
  /** Whether the provider issued a replay signature for this call. */
  signed?: boolean;
}

export type TranscriptEntry =
  | {
      kind: "model-request";
      role: string;
      correlationId: string;
      systemInstruction: string;
      turns: readonly LoggedTurn[];
      tools: readonly string[];
      hostedTools: readonly string[];
      responseFormat?: string;
    }
  | {
      kind: "model-response";
      role: string;
      correlationId: string;
      text: string;
      toolCalls: readonly LoggedToolCall[];
      hostedToolStatuses: readonly { name: string; state: string; outputChars: number }[];
      artifacts: readonly { artifactType: string; title: string }[];
      finishReason?: string;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      durationMs: number;
      providerRequestId?: string;
    }
  | { kind: "model-error"; role: string; correlationId: string; error: string; durationMs: number }
  | { kind: "orchestrator"; correlationId: string; event: string; detail: Record<string, unknown> };

export interface TranscriptLogger {
  readonly enabled: boolean;
  /** Absolute-or-relative path entries are appended to, or `undefined` when disabled. */
  readonly file: string | undefined;
  record(entry: TranscriptEntry): void;
}

export const NOOP_TRANSCRIPT_LOGGER: TranscriptLogger = Object.freeze({
  enabled: false as const,
  file: undefined,
  record() {},
});

function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
}

function capEntry(entry: TranscriptEntry, maxChars: number): TranscriptEntry {
  if (entry.kind === "model-request") {
    return {
      ...entry,
      systemInstruction: truncate(entry.systemInstruction, maxChars),
      turns: entry.turns.map((turn) => ({ ...turn, content: truncate(turn.content, maxChars) })),
    };
  }
  if (entry.kind === "model-response") return { ...entry, text: truncate(entry.text, maxChars) };
  return entry;
}

function consoleSummary(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "model-request":
      return `request ${entry.role} corr=${entry.correlationId} turns=${entry.turns.length}`
        + ` tools=[${entry.tools.join(",")}] hosted=[${entry.hostedTools.join(",")}]`
        + `${entry.responseFormat ? ` schema=${entry.responseFormat}` : ""}`;
    case "model-response":
      return `response ${entry.role} corr=${entry.correlationId} textChars=${entry.text.length}`
        + ` toolCalls=[${entry.toolCalls.map((call) => call.name ?? "?").join(",")}]`
        + ` hosted=[${entry.hostedToolStatuses.map((status) => `${status.name}:${status.state}`).join(",")}]`
        + ` finish=${entry.finishReason ?? "-"} prompt=${entry.usage?.promptTokens ?? "?"}`
        + ` completion=${entry.usage?.completionTokens ?? "?"} ${entry.durationMs}ms`;
    case "model-error":
      return `error ${entry.role} corr=${entry.correlationId} ${entry.error} ${entry.durationMs}ms`;
    default:
      return `orchestrator ${entry.event} corr=${entry.correlationId} ${JSON.stringify(entry.detail)}`;
  }
}

/**
 * Opens one JSONL file per process start. A failed write is reported once
 * and then swallowed: a diagnostic log must never be able to fail a turn.
 */
export function createTranscriptLogger(
  config: TranscriptLogConfig = readTranscriptLogConfig(),
  startedAt: Date = new Date(),
): TranscriptLogger {
  if (!config.enabled) return NOOP_TRANSCRIPT_LOGGER;
  const stamp = startedAt.toISOString().replaceAll(/[:.]/gu, "-");
  let target: string;
  try {
    mkdirSync(config.directory, { recursive: true });
    target = join(config.directory, `conversation-${stamp}.jsonl`);
  } catch (error) {
    console.warn("[transcript] could not open the conversation log directory", error);
    return NOOP_TRANSCRIPT_LOGGER;
  }
  let reportedWriteFailure = false;
  console.info(`[transcript] conversation logging enabled -> ${target}`);
  return {
    enabled: true,
    file: target,
    record(entry) {
      if (config.console) console.info(`[transcript] ${consoleSummary(entry)}`);
      try {
        appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), ...capEntry(entry, config.maxFieldChars) })}\n`, "utf8");
      } catch (error) {
        if (!reportedWriteFailure) {
          reportedWriteFailure = true;
          console.warn("[transcript] could not write the conversation log", error);
        }
      }
    },
  };
}

function loggedTurns(turns: readonly ConversationTurn[]): LoggedTurn[] {
  return turns.map((turn) => ({
    role: turn.role,
    ...(turn.name ? { name: turn.name } : {}),
    ...(turn.toolCallId ? { toolCallId: turn.toolCallId } : {}),
    content: turn.content,
    ...(turn.toolCalls?.length
      ? { toolCalls: turn.toolCalls.map(({ signature, ...call }) => ({ ...call, ...(signature ? { signed: true } : {}) })) }
      : {}),
  }));
}

/**
 * Wraps one role's adapter so every call it makes is transcribed. The
 * wrapper is transparent -- it re-yields each event unchanged and rethrows
 * unchanged -- so enabling the log cannot alter what the orchestrator sees.
 */
export function withTranscriptLog(adapter: ModelAdapter, role: string, logger: TranscriptLogger): ModelAdapter {
  if (!logger.enabled) return adapter;
  return {
    provider: adapter.provider,
    async *stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent> {
      const startedAt = Date.now();
      logger.record({
        kind: "model-request",
        role,
        correlationId: request.correlationId,
        systemInstruction: request.systemInstruction,
        turns: loggedTurns(request.turns),
        tools: (request.tools ?? []).map((tool) => tool.name),
        hostedTools: [...(request.hostedTools ?? [])],
        ...(request.responseFormat ? { responseFormat: request.responseFormat.name } : {}),
      });
      let text = "";
      const toolCalls = new Map<number, LoggedToolCall>();
      const hostedToolStatuses: { name: string; state: string; outputChars: number }[] = [];
      const artifacts: { artifactType: string; title: string }[] = [];
      let finishReason: string | undefined;
      let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
      let providerRequestId: string | undefined;
      try {
        for await (const event of adapter.stream(request)) {
          switch (event.type) {
            case "text-delta":
              text += event.text;
              break;
            case "tool-call-delta": {
              const existing = toolCalls.get(event.index) ?? { index: event.index, arguments: "" };
              if (event.id) existing.id = event.id;
              if (event.name) existing.name = event.name;
              // Recorded as a flag, never verbatim: the signature is a long
              // opaque provider token, and whether one arrived is the whole
              // diagnostic question.
              if (event.signature) existing.signed = true;
              existing.arguments += event.argumentsDelta;
              toolCalls.set(event.index, existing);
              break;
            }
            case "hosted-tool-status":
              hostedToolStatuses.push({ name: event.name, state: event.state, outputChars: event.output?.length ?? 0 });
              break;
            case "artifact":
              artifacts.push({ artifactType: event.artifactType, title: event.title });
              break;
            case "finish":
              finishReason = event.reason;
              break;
            case "usage":
              usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens, totalTokens: event.totalTokens };
              break;
            case "request-metadata":
              providerRequestId = event.providerRequestId;
              break;
          }
          yield event;
        }
      } catch (error) {
        logger.record({
          kind: "model-error",
          role,
          correlationId: request.correlationId,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
      logger.record({
        kind: "model-response",
        role,
        correlationId: request.correlationId,
        text,
        toolCalls: [...toolCalls.values()].sort((a, b) => a.index - b.index),
        hostedToolStatuses,
        artifacts,
        ...(finishReason ? { finishReason } : {}),
        ...(usage ? { usage } : {}),
        durationMs: Date.now() - startedAt,
        ...(providerRequestId ? { providerRequestId } : {}),
      });
    },
  };
}
