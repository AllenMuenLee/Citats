import type { UiSourceReference, UiWarning } from "@ai-browser/contracts";

export type GenerativeUiFallback = {
  kind: "generative-ui-warning";
  warning: UiWarning;
  text: string;
  sources: UiSourceReference[];
  diagnostics: {
    componentType?: string;
    schemaVersion?: string;
    issues: string[];
  };
};

export function createValidationFallback(input: {
  componentType?: string;
  schemaVersion?: string;
  text: string;
  sources?: UiSourceReference[];
  issues: string[];
}): GenerativeUiFallback {
  return {
    kind: "generative-ui-warning",
    warning: {
      code: "validation_failed",
      message: "This generated view could not be displayed safely. A text version is shown instead.",
    },
    text: input.text,
    sources: input.sources ?? [],
    diagnostics: {
      componentType: input.componentType,
      schemaVersion: input.schemaVersion,
      issues: input.issues.slice(0, 20).map((issue) => issue.slice(0, 300)),
    },
  };
}
