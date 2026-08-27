import { z } from "zod";
import { ToolDefinitionSchema } from "../tool-definition";
import { GenerativeUiPlanSchema } from "../page-understanding";

/**
 * `ui.propose_generative_ui_plan` -- Phase 3 (P03-F05 steps 5-6). The ONLY
 * way the model may express generated-UI display intent: calling this tool
 * with a `GenerativeUiPlan` (never React/HTML/CSS/JavaScript, a raw API, a
 * selector, or a URL for execution) as its arguments. The server validates
 * the plan (schema + that every handle it references belongs to the
 * `observationId` it names) and always reports back that no Phase-4
 * presentation primitive is registered yet -- Phase 3 does not render
 * anything; it only validates the plan and hands the validated plan to
 * whatever later phase implements the generative-UI boundary (see
 * `services/browser/src/browser_service/tools/propose_generative_ui_plan.py`).
 * The model must not restate the plan or the underlying records in prose after this call; the
 * generated UI (or its fallback) is the answer, so any accompanying text should stay to a short
 * offer or confirmation, never a duplicate description of the plan's fields or contents.
 */
export const PROPOSE_GENERATIVE_UI_PLAN_TOOL_NAME = "ui.propose_generative_ui_plan" as const;

export const ProposeGenerativeUiPlanArgsSchema = GenerativeUiPlanSchema;

export type ProposeGenerativeUiPlanArgs = z.infer<typeof ProposeGenerativeUiPlanArgsSchema>;

export const ProposeGenerativeUiPlanFallbackSchema = z.enum(["cited_text", "generic_collection"]);

export const ProposeGenerativeUiPlanResultSchema = z
  .object({
    accepted: z.boolean(),
    /** Always `false` in this phase: no Phase-4 presentation-primitive registry exists yet. */
    rendered: z.literal(false),
    fallback: ProposeGenerativeUiPlanFallbackSchema,
    reason: z.string().min(1).max(300),
  })
  .strict();

export type ProposeGenerativeUiPlanResult = z.infer<typeof ProposeGenerativeUiPlanResultSchema>;

export const ProposeGenerativeUiPlanToolDefinition = ToolDefinitionSchema.parse({
  contractVersion: 1,
  name: PROPOSE_GENERATIVE_UI_PLAN_TOOL_NAME,
  description:
    "Proposes a declarative display plan (layout, fields, ordering, filters) for the results of a " +
    "prior browser.explore_website call, using only opaque handles from that observation. Never " +
    "renders anything itself and never accepts React/HTML/CSS/JavaScript, a raw API, a selector, or " +
    "a URL for execution. Call proactively when reviewing/comparing multiple similar records, without " +
    "being asked. Afterward, do not restate the plan or records in prose -- reply in one short sentence.",
  argsSchemaVersion: 1,
  argsSchemaRef: "ui.propose_generative_ui_plan.v1",
  sensitiveByDefault: false,
});
