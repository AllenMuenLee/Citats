import { z } from "zod";
import { ToolDefinitionSchema } from "../tool-definition";
import { GenerativeUiPlanSchema } from "../page-understanding";

/**
 * `ui.propose_generative_ui_plan` -- Phase 3 (P03-F05 steps 5-6). The ONLY
 * way Mistral may express generated-UI display intent: calling this tool
 * with a `GenerativeUiPlan` (never React/HTML/CSS/JavaScript, a raw API, a
 * selector, or a URL for execution) as its arguments. The server validates
 * the plan (schema + that every handle it references belongs to the
 * `observationId` it names) and always reports back that no Phase-4
 * presentation primitive is registered yet -- Phase 3 does not render
 * anything; it only validates the plan and hands the validated plan to
 * whatever later phase implements the generative-UI boundary (see
 * `services/browser/src/browser_service/tools/propose_generative_ui_plan.py`).
 * Mistral must continue the answer in ordinary cited text after this call.
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
    "Proposes a declarative display plan (layout kind, source collections, selected fields, ordering, " +
    "filters) for the results of a prior browser.explore_website call, using only opaque handles from " +
    "that same observation. This never renders anything itself and never accepts React/HTML/CSS/" +
    "JavaScript, a raw API, a selector, or a URL for execution -- after calling this, continue the " +
    "answer in ordinary cited text describing the same records.",
  argsSchemaVersion: 1,
  argsSchemaRef: "ui.propose_generative_ui_plan.v1",
  sensitiveByDefault: false,
});
