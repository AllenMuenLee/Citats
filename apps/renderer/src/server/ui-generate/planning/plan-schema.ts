import "server-only";

import { UiPlanDraftSchema } from "@ai-browser/contracts";
import { z } from "zod";

/**
 * The provider structured-output schema for a `UiPlan` draft, derived from
 * the Zod source of truth rather than hand-written -- so the shape the
 * planner is constrained to and the shape the server validates cannot drift
 * apart.
 *
 * String bounds and patterns are then stripped. Every `minLength`,
 * `maxLength`, and `pattern` multiplies the states of the automaton a
 * provider compiles a constrained-decoding schema into, and a schema this
 * size tips past both providers' limits with them left in (the same
 * trade-off `server/ai/model-json.ts` documents). Nothing is lost: those
 * bounds are re-applied, exactly, by `UiPlanDraftSchema.parse` on the way
 * back in. Structure, required fields, enums, and consts are kept, because
 * those are what actually stop the model inventing a field name.
 */
function relaxForProvider(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relaxForProvider);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key]) => key !== "minLength" && key !== "maxLength" && key !== "pattern" && key !== "$schema",
  );
  return Object.fromEntries(entries.map(([key, entry]) => [key, relaxForProvider(entry)]));
}

export const UI_PLAN_RESPONSE_JSON_SCHEMA: Record<string, unknown> = relaxForProvider(
  z.toJSONSchema(UiPlanDraftSchema, { target: "draft-7", io: "input" }),
) as Record<string, unknown>;
