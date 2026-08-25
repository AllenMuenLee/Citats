import { z } from "zod";

/**
 * Closed set of tool-call error codes/classes. This enum is exhaustive by
 * design -- an error that doesn't fit one of these is `INTERNAL`. Adding a
 * new code is a non-breaking additive change on the *producing* side only
 * if every consumer is updated in lockstep (see the enum-membership note
 * in `sensitivity.ts`); changing what an existing code *means* is a
 * breaking change per `version.ts`.
 */
export const ToolErrorCodeSchema = z.enum([
  /** The invocation arguments failed schema validation. */
  "INVALID_ARGUMENTS",
  /** `toolName` does not match any registered tool. */
  "UNKNOWN_TOOL",
  /** The tool call did not complete within its allotted time budget. */
  "TIMEOUT",
  /** The tool call was cancelled (see `cancellation.ts`). */
  "CANCELLED",
  /** A required upstream dependency (browser, page, network) was unavailable. */
  "UPSTREAM_UNAVAILABLE",
  /** Any other failure. The catch-all -- never leaks internal detail (see `message`). */
  "INTERNAL",
]);

export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * A safe, human-readable error message. This field must NEVER contain
 * stack traces, file paths, connection strings, or any other internal
 * detail that could leak implementation information -- producers are
 * responsible for mapping internal exceptions to one of these short,
 * user-safe strings before constructing an error result. Length is capped
 * to make that discipline structurally cheap to keep (a stack trace won't
 * fit).
 */
export const SafeErrorMessageSchema = z.string().min(1).max(ERROR_MESSAGE_MAX_LENGTH);
