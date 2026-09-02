import { z } from "zod";
import { ToolDefinitionSchema } from "../tool-definition";

/**
 * `ui.generate` -- the *only* model-callable capability for UI creation
 * (Phase 2, P02-F01).
 *
 * The conversation model has exactly two choices on any turn: answer in
 * text, or call this once with the user's request copied verbatim. It does
 * not choose a site, a URL, a layout, a component, or a stage; every step
 * after this call is fixed trusted code (Phases 3 and 4).
 *
 * ```text
 * user -> conversation model -> text
 *                            -> ui.generate -> fixed pipeline -> ready/failed
 * ```
 *
 * Nothing in this file can carry a URL, HTML, TSX, a plan, a selector, a
 * model setting, or a pipeline option in either direction. That is the
 * point: the argument shape is one bounded string, and the result union is
 * closed around an opaque reference plus display metadata.
 */
export const UI_GENERATE_TOOL_NAME = "ui.generate" as const;

export const UI_GENERATE_ARGS_SCHEMA_VERSION = 1;
export const UI_GENERATE_ARGS_SCHEMA_REF = "ui.generate.v1" as const;

/**
 * Bound on the request copied into the call. Long enough for any real
 * request a chat composer accepts in one turn, short enough that a model
 * cannot use the field as a channel for a pasted document, a page, or a
 * prompt of its own.
 */
export const UI_GENERATE_REQUEST_MAX_LENGTH = 2_000;

export const UiGenerateArgsSchema = z
  .object({
    /**
     * The current user request, copied exactly. Trusted code re-checks this
     * against the actual turn text after transport validation, so a model
     * that paraphrases, appends, or substitutes fails the call rather than
     * steering the pipeline.
     */
    request: z
      .string()
      .min(1)
      .max(UI_GENERATE_REQUEST_MAX_LENGTH)
      .refine((request) => request.trim().length > 0, "request must contain non-whitespace text"),
  })
  .strict();

export type UiGenerateArgs = z.infer<typeof UiGenerateArgsSchema>;

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Server-emitted progress states, in the fixed order the pipeline runs
 * them. These are **events, not tools**: the model cannot request one,
 * skip one, reorder them, or observe anything about a stage beyond the
 * fact that it started.
 */
export const UI_GENERATE_PROGRESS_STATES = [
  "source_finding",
  "page_capture",
  "ui_planning",
  "ui_generation",
  "validation",
  "rendering",
] as const;

export const UiGenerateProgressStateSchema = z.enum(UI_GENERATE_PROGRESS_STATES);
export type UiGenerateProgressState = z.infer<typeof UiGenerateProgressStateSchema>;

export const UiGenerateProgressEventSchema = z
  .object({
    state: UiGenerateProgressStateSchema,
    /** Monotonic within one `ui.generate` execution, starting at 1. */
    sequence: z.number().int().positive().max(UI_GENERATE_PROGRESS_STATES.length),
  })
  .strict();

export type UiGenerateProgressEvent = z.infer<typeof UiGenerateProgressEventSchema>;

// ---------------------------------------------------------------------------
// Result union
// ---------------------------------------------------------------------------

/**
 * Stable failure categories. Each names *which stage* could not complete,
 * never why in terms a page or a model authored -- there is no category
 * whose value is derived from untrusted content.
 */
export const UI_GENERATE_FAILURE_CATEGORIES = [
  "not_configured",
  "no_sources",
  "capture_failed",
  "planning_failed",
  "generation_failed",
  "validation_failed",
  "render_failed",
  "cancelled",
  "deadline_exceeded",
  "internal",
] as const;

export const UiGenerateFailureCategorySchema = z.enum(UI_GENERATE_FAILURE_CATEGORIES);
export type UiGenerateFailureCategory = z.infer<typeof UiGenerateFailureCategorySchema>;

/**
 * Opaque reference to a generated view. It resolves only inside the
 * trusted server's own instance store; it is not an artifact id, a URL, a
 * path, or anything the model or the page can dereference.
 */
export const GeneratedViewRefSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^uiv_[A-Za-z0-9_-]{4,124}$/, "must be an opaque generated-view reference");

/**
 * Everything the conversation model is allowed to learn about a view that
 * rendered. No HTML, no TSX, no prompt, no model output, no URL, no
 * credential, no cookie, no header, no browser state -- a short display
 * title, how many sources stand behind it, and whether coverage was
 * complete.
 */
export const UiGenerateReadyResultSchema = z
  .object({
    status: z.literal("ready"),
    viewRef: GeneratedViewRefSchema,
    title: z.string().trim().min(1).max(120),
    sourceCount: z.number().int().nonnegative().max(64),
    coverage: z.enum(["validated", "partial"]),
  })
  .strict();

export type UiGenerateReadyResult = z.infer<typeof UiGenerateReadyResultSchema>;

export const UiGenerateFailedResultSchema = z
  .object({
    status: z.literal("failed"),
    category: UiGenerateFailureCategorySchema,
    /** Server-authored, safe, and fixed per category -- never a provider or page string. */
    message: z.string().trim().min(1).max(300),
  })
  .strict();

export type UiGenerateFailedResult = z.infer<typeof UiGenerateFailedResultSchema>;

/**
 * The closed result union appended to model context. There is deliberately
 * no third arm: a stage that has not finished is not a result, and
 * "probably ready" is not a state the model can be told about.
 */
export const UiGenerateResultSchema = z.discriminatedUnion("status", [
  UiGenerateReadyResultSchema,
  UiGenerateFailedResultSchema,
]);

export type UiGenerateResult = z.infer<typeof UiGenerateResultSchema>;

/** Fixed, server-authored message per failure category. */
export const UI_GENERATE_FAILURE_MESSAGES: Readonly<Record<UiGenerateFailureCategory, string>> =
  Object.freeze({
    not_configured: "Generated UI is not configured on this installation.",
    no_sources: "No usable source website could be identified for this request.",
    capture_failed: "No source website could be captured for this request.",
    planning_failed: "A usable interface plan could not be produced for this request.",
    generation_failed: "The interface could not be generated for this request.",
    validation_failed: "The generated interface did not pass validation.",
    render_failed: "The generated interface did not finish rendering.",
    cancelled: "Interface generation was stopped.",
    deadline_exceeded: "Interface generation ran out of time.",
    internal: "Interface generation failed.",
  });

export function uiGenerateFailure(category: UiGenerateFailureCategory): UiGenerateFailedResult {
  return { status: "failed", category, message: UI_GENERATE_FAILURE_MESSAGES[category] };
}

export const UiGenerateToolDefinition = ToolDefinitionSchema.parse({
  contractVersion: 1,
  name: UI_GENERATE_TOOL_NAME,
  description:
    "Builds an interactive generated interface for the user's current request and opens it beside " +
    "the conversation. Call it at most once per turn, with the user's request copied exactly, when " +
    "an interactive or visual interface would materially help. Everything else -- finding sources, " +
    "reading them, designing, generating, and rendering -- is handled by the server.",
  argsSchemaVersion: UI_GENERATE_ARGS_SCHEMA_VERSION,
  argsSchemaRef: UI_GENERATE_ARGS_SCHEMA_REF,
  sensitiveByDefault: false,
});

/** The JSON Schema offered to the provider for this tool's arguments. Mirrors `UiGenerateArgsSchema`. */
export const UI_GENERATE_ARGS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["request"],
  properties: {
    request: {
      type: "string",
      minLength: 1,
      maxLength: UI_GENERATE_REQUEST_MAX_LENGTH,
      description: "The user's current request, copied exactly and unchanged.",
    },
  },
} as const;
