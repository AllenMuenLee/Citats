import { buildSystemInstruction } from "./instructions";
import type { ConversationMessage, ConversationPart, ConversationTurn } from "./types";

export interface ContextLimits {
  readonly maxMessages: number;
  readonly maxEstimatedTokens: number;
}

export interface SelectedContext {
  readonly systemInstruction: string;
  readonly messages: readonly ConversationMessage[];
  readonly estimatedTokens: number;
  readonly droppedTurnIds: readonly string[];
}

function stableValueLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function partLength(part: ConversationPart): number {
  if (part.type === "text") return part.text.length;
  return part.toolName.length + part.invocationId.length + stableValueLength(part.type === "tool-call" ? part.arguments : part.result);
}

export function estimateMessageTokens(message: ConversationMessage): number {
  return 4 + Math.ceil(message.parts.reduce((sum, part) => sum + partLength(part), 0) / 4);
}

export function selectConversationContext(turns: readonly ConversationTurn[], limits: ContextLimits): SelectedContext {
  if (!Number.isInteger(limits.maxMessages) || limits.maxMessages < 1) throw new Error("maxMessages must be a positive integer");
  if (!Number.isInteger(limits.maxEstimatedTokens) || limits.maxEstimatedTokens < 1) throw new Error("maxEstimatedTokens must be a positive integer");

  const systemInstruction = buildSystemInstruction();
  const systemTokens = Math.ceil(systemInstruction.length / 4);
  const selected: ConversationTurn[] = [];
  const activeTurn = turns.at(-1)?.complete === false ? turns.at(-1) : undefined;
  let messageCount = activeTurn?.messages.length ?? 0;
  let estimatedTokens = systemTokens + (activeTurn?.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) ?? 0);

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn.complete) continue;
    const turnTokens = turn.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    const fits = messageCount + turn.messages.length <= limits.maxMessages && estimatedTokens + turnTokens <= limits.maxEstimatedTokens;
    if (!fits && selected.length > 0) break;
    selected.unshift(turn);
    messageCount += turn.messages.length;
    estimatedTokens += turnTokens;
  }

  const selectedIds = new Set(selected.map((turn) => turn.id));
  return {
    systemInstruction,
    messages: [...selected.flatMap((turn) => turn.messages), ...(activeTurn?.messages ?? [])],
    estimatedTokens,
    droppedTurnIds: turns.filter((turn) => turn.complete && !selectedIds.has(turn.id)).map((turn) => turn.id),
  };
}
