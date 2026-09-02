import { describe, expect, it } from "vitest";
import { UiPlanSchema, canonicalizeUiPlan, digestUiPlan } from "@ai-browser/contracts";
import { validUiPlan } from "./helpers/ui-plan";

/**
 * P03-F03 validation: the plan contract has to reject exactly the things
 * that would otherwise become an unsupported claim, an unresolvable
 * reference, or an unbounded render in the generated component.
 */
describe("UiPlan contract", () => {
  it("accepts a complete plan", () => {
    const plan = validUiPlan();
    expect(plan.records).toHaveLength(2);
    expect(plan.components.find((component) => component.role === "root")?.componentId).toBe("root");
  });

  it("rejects unknown fields", () => {
    const plan = { ...validUiPlan(), surprise: true };
    expect(UiPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects a fact attributed to a source that was never captured", () => {
    const base = validUiPlan();
    const plan = { ...base, facts: [{ ...base.facts[0]!, sourceId: "src-9" }] };
    expect(UiPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects a component referencing a record the plan does not declare", () => {
    const base = validUiPlan();
    const plan = {
      ...base,
      components: base.components.map((component) => (component.componentId === "table" ? { ...component, recordIds: ["rec-404"] } : component)),
    };
    expect(UiPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects a component graph that is not a single rooted tree", () => {
    const base = validUiPlan();
    const cyclic = {
      ...base,
      components: base.components.map((component) => (component.componentId === "table" ? { ...component, childIds: ["root"] } : component)),
    };
    expect(UiPlanSchema.safeParse(cyclic).success).toBe(false);

    const orphaned = {
      ...base,
      components: base.components.map((component) => (component.componentId === "root" ? { ...component, childIds: ["summary"] } : component)),
    };
    expect(UiPlanSchema.safeParse(orphaned).success).toBe(false);
  });

  it("rejects markup, code, and URL schemes in display text", () => {
    for (const value of ["<script>x</script>", "javascript:alert(1)", "{{token}}", "<b>bold</b>"]) {
      const base = validUiPlan();
      const plan = { ...base, facts: [{ ...base.facts[0]!, value }] };
      expect(UiPlanSchema.safeParse(plan).success, value).toBe(false);
    }
  });

  it("rejects a coverage claim that disagrees with the captured sources", () => {
    const base = validUiPlan();
    expect(UiPlanSchema.safeParse({ ...base, coverage: { ...base.coverage, capturedSources: 2 } }).success).toBe(false);
    expect(UiPlanSchema.safeParse({ ...base, coverage: { ...base.coverage, requestedSources: 0 } }).success).toBe(false);
  });

  it("rejects duplicate interaction state keys", () => {
    const base = validUiPlan();
    const plan = {
      ...base,
      localInteractions: [base.localInteractions[0]!, { ...base.localInteractions[0]!, interactionId: "int-2" }],
    };
    expect(UiPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("canonicalizes independently of unordered array order", () => {
    const base = validUiPlan();
    const reordered = validUiPlan({ records: [base.records[1]!, base.records[0]!] });
    expect(canonicalizeUiPlan(reordered)).toBe(canonicalizeUiPlan(base));
    expect(digestUiPlan(reordered)).toBe(digestUiPlan(base));
  });

  it("changes its digest when meaningful content changes", () => {
    const base = validUiPlan();
    const changed = validUiPlan({ canonicalGoal: "Compare three coffee grinders" });
    expect(digestUiPlan(changed)).not.toBe(digestUiPlan(base));
  });

  it("keeps ordered arrays ordered through canonicalization", () => {
    const base = validUiPlan();
    const swapped = validUiPlan({
      informationArchitecture: { ...base.informationArchitecture, sectionIds: ["table", "summary"] },
    });
    expect(digestUiPlan(swapped)).not.toBe(digestUiPlan(base));
  });
});
