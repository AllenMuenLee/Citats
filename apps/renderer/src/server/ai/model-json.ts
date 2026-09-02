import "server-only";

import type { z } from "zod";

/**
 * Decoding helpers for model calls that ask for their JSON in the prompt
 * rather than through a provider structured-output schema.
 *
 * Two roles work this way -- the observation digest and the UI implementation
 * plan. Both are read by another model rather than executed, both re-derive
 * everything trustworthy from the observation afterwards, and both are better
 * off degrading than failing: a provider that rejects the schema outright
 * (Gemini answers HTTP 400 INVALID_ARGUMENT once a schema's constrained
 * decoding automaton grows past its budget, and Gemma rejects these schemas
 * at any size) turns the whole stage off, which is a far worse outcome than
 * an imperfect parse.
 *
 * So the rule here is the opposite of the routing classifier's in
 * `orchestrator/routing.ts`: that one is a security boundary and fails
 * closed on anything it does not recognize, while these two salvage whatever
 * the model actually produced.
 */

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

const FENCED_BLOCK = /```(?:[A-Za-z][\w+-]*)?[ \t]*\r?\n([\s\S]*?)```/gu;

/**
 * Splits one free-form response into its prose and the JSON object it
 * carries, if any.
 *
 * The search is deliberately permissive, in this order: the last fenced block
 * that parses as an object, then a trailing unfenced object, then a response
 * that is nothing but one object (what a model still answering in pure JSON
 * returns). Prose is whatever sits outside the object -- before it, or after
 * it when the model led with the block. A response with no parseable object
 * is all prose, which is still usable output for both callers.
 *
 * Callers decide which half wins when both carry the same field.
 */
export function splitModelJson(raw: string): { prose: string; object: Record<string, unknown> | undefined } {
  const blocks = [...raw.matchAll(FENCED_BLOCK)];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    const parsed = tryParseObject(block[1]!);
    if (parsed) {
      const before = raw.slice(0, block.index).trim();
      return { prose: before || raw.slice(block.index + block[0].length).trim(), object: parsed };
    }
  }
  const trailing = raw.lastIndexOf("\n{");
  if (trailing >= 0) {
    const parsed = tryParseObject(raw.slice(trailing));
    if (parsed) return { prose: raw.slice(0, trailing).trim(), object: parsed };
  }
  const whole = tryParseObject(raw);
  if (whole) return { prose: "", object: whole };
  return { prose: raw.trim(), object: undefined };
}

/**
 * Keeps the entries of `value` that parse, drops the rest, and bounds the
 * result. Parsing element by element is the point: one malformed entry costs
 * that entry rather than the whole array, and a field that is missing or not
 * an array at all resolves to `[]` -- which is the state every caller's
 * deterministic defaults already handle.
 */
export function keepValid<T>(schema: z.ZodType<T>, value: unknown, max: number): T[] {
  if (!Array.isArray(value)) return [];
  const kept: T[] = [];
  for (const item of value) {
    if (kept.length >= max) break;
    const parsed = schema.safeParse(item);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}
