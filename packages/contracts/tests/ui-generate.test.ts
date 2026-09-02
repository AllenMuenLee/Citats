import { describe, expect, it } from "vitest";
import {
  UI_GENERATE_FAILURE_CATEGORIES,
  UI_GENERATE_FAILURE_MESSAGES,
  UI_GENERATE_PROGRESS_STATES,
  UI_GENERATE_REQUEST_MAX_LENGTH,
  UiGenerateArgsSchema,
  UiGenerateProgressEventSchema,
  UiGenerateResultSchema,
  uiGenerateFailure,
} from "../src/index.js";

describe("ui.generate contracts", () => {
  it("preserves the exact validated request", () => {
    const request = "  Compare these options visually.  ";
    expect(UiGenerateArgsSchema.parse({ request }).request).toBe(request);
  });

  it("enforces request bounds and rejects unknown fields", () => {
    expect(UiGenerateArgsSchema.safeParse({ request: "x".repeat(UI_GENERATE_REQUEST_MAX_LENGTH) }).success).toBe(true);
    expect(UiGenerateArgsSchema.safeParse({ request: "x".repeat(UI_GENERATE_REQUEST_MAX_LENGTH + 1) }).success).toBe(false);
    expect(UiGenerateArgsSchema.safeParse({ request: "  \n" }).success).toBe(false);
    expect(UiGenerateArgsSchema.safeParse({ request: "Build a table", url: "https://example.com" }).success).toBe(false);
  });

  it("accepts only the fixed ordered progress states", () => {
    UI_GENERATE_PROGRESS_STATES.forEach((state, index) => {
      expect(UiGenerateProgressEventSchema.parse({ state, sequence: index + 1 })).toEqual({ state, sequence: index + 1 });
    });
    expect(UiGenerateProgressEventSchema.safeParse({ state: "complete", sequence: 1 }).success).toBe(false);
    expect(UiGenerateProgressEventSchema.safeParse({ state: "source_finding", sequence: 1, html: "<p>x</p>" }).success).toBe(false);
  });

  it("round-trips both closed result arms without unsafe fields", () => {
    const ready = { status: "ready", viewRef: "uiv_abc12345", title: "Comparison", sourceCount: 2, coverage: "validated" };
    const failed = uiGenerateFailure("generation_failed");
    for (const value of [ready, failed]) {
      const parsed = UiGenerateResultSchema.parse(JSON.parse(JSON.stringify(value)));
      expect(parsed).toEqual(value);
    }
    expect(UiGenerateResultSchema.safeParse({ ...ready, html: "<p>x</p>" }).success).toBe(false);
    expect(UiGenerateResultSchema.safeParse({ ...failed, prompt: "secret" }).success).toBe(false);
    expect(UiGenerateResultSchema.safeParse({ status: "pending" }).success).toBe(false);
  });

  it("has one fixed safe message for every failure category", () => {
    for (const category of UI_GENERATE_FAILURE_CATEGORIES) {
      expect(uiGenerateFailure(category)).toEqual({ status: "failed", category, message: UI_GENERATE_FAILURE_MESSAGES[category] });
    }
  });
});
