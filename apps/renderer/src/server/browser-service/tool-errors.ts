import "server-only";

import { z } from "zod";
import type { ToolErrorCode } from "@ai-browser/contracts";

import {
  BrowserServiceContractError,
  BrowserServiceTimeoutError,
  BrowserServiceUnavailableError,
} from "./errors";

/**
 * Classification of one failed tool execution (P03-R01 steps 3-4).
 *
 * Before this existed, every exception that escaped a tool's `execute` --
 * a browser-service timeout included -- was collapsed by the orchestrator
 * into `INTERNAL` / "The tool could not complete safely.". That is the
 * message the reproduced Airbnb failure surfaced, and it is wrong twice
 * over: it tells the user nothing actionable, and it tells the model that
 * an unexpected defect occurred when in fact a bounded deadline was
 * exhausted, which is ordinary and retryable.
 *
 * A structured `ToolErrorResult` the browser service produced itself is
 * never routed through here -- the client returns those unchanged, and the
 * orchestrator treats them as results rather than as thrown errors.
 */
export interface ToolErrorClassification {
  errorCode: ToolErrorCode;
  /**
   * Safe, user-facing summary. Says what failed, that nothing was changed
   * (every tool reachable from here is read-only), and what recovery is
   * available. Never carries the underlying exception text, which may
   * quote untrusted page content.
   */
  message: string;
  retryable: boolean;
  /** Stable label for server-side logs and metrics -- never shown to the user or the model. */
  category:
    | "browser_service_timeout"
    | "browser_service_unavailable"
    | "browser_service_contract"
    | "cancelled"
    | "invalid_arguments"
    | "unexpected";
}

const UNEXPECTED: ToolErrorClassification = Object.freeze({
  errorCode: "INTERNAL",
  message: "The tool could not complete safely. Nothing was changed.",
  retryable: true,
  category: "unexpected",
});

/**
 * Whether `error` is an abort raised by the caller's own signal -- the user
 * pressing Stop -- rather than by an internal deadline. Node raises these
 * as a `DOMException` named `AbortError`; `AbortSignal.timeout` raises
 * `TimeoutError` instead, which is deliberately not treated as cancellation.
 */
function isCallerAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Maps a thrown execution error onto the closed `ToolErrorCode` set.
 * Returns `null` when the error is genuinely unrecognised, so the caller
 * decides whether that is an `INTERNAL` defect -- this module never
 * silently launders an unexpected failure into a benign-looking code.
 */
export function classifyToolExecutionError(error: unknown): ToolErrorClassification | null {
  if (error instanceof BrowserServiceTimeoutError) {
    return {
      errorCode: "TIMEOUT",
      message:
        "The website took too long to respond within its time budget, so the request was stopped. "
        + "Nothing was changed. Retrying, or trying a more specific page, may succeed.",
      retryable: true,
      category: "browser_service_timeout",
    };
  }
  if (error instanceof BrowserServiceUnavailableError) {
    return {
      errorCode: "UPSTREAM_UNAVAILABLE",
      message:
        "The local browsing service could not be reached. Nothing was changed. This is usually temporary and can be retried.",
      retryable: true,
      category: "browser_service_unavailable",
    };
  }
  if (error instanceof BrowserServiceContractError) {
    // Upstream produced a response this build cannot use -- a version skew
    // or a service defect, not a defect in the orchestrator. Reported as an
    // upstream failure rather than `INTERNAL`, but not retryable: the same
    // invocation would produce the same unusable response.
    return {
      errorCode: "UPSTREAM_UNAVAILABLE",
      message: "The local browsing service returned a response this app could not use. Nothing was changed.",
      retryable: false,
      category: "browser_service_contract",
    };
  }
  if (isCallerAbort(error)) {
    return {
      errorCode: "CANCELLED",
      message: "The request was cancelled before it finished. Nothing was changed.",
      retryable: true,
      category: "cancelled",
    };
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return {
      errorCode: "INVALID_ARGUMENTS",
      message: "The tool arguments were invalid. Nothing was changed.",
      retryable: false,
      category: "invalid_arguments",
    };
  }
  return null;
}

/**
 * The classification for an error, falling back to the `INTERNAL` defect
 * case. Kept separate from `classifyToolExecutionError` so a caller that
 * needs to distinguish "recognised" from "fell through" still can.
 */
export function classifyToolExecutionErrorOrInternal(error: unknown): ToolErrorClassification {
  return classifyToolExecutionError(error) ?? UNEXPECTED;
}
