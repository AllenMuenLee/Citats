import "server-only";

import {
  EXPLORE_WEBSITE_TOOL_NAME,
  GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME,
  NAVIGATE_AND_EXTRACT_TOOL_NAME,
  SYSTEM_ECHO_TOOL_NAME,
} from "@ai-browser/contracts";

/**
 * Server-owned wall-clock budgets for one browser-service invocation, keyed
 * by tool kind (P03-R01 steps 1-2).
 *
 * The single five-second bridge timeout this replaces was the direct cause
 * of the reproduced Airbnb failure: the renderer aborted the request while
 * the browser service was legitimately still inside its own thirty-second
 * navigation budget, so a healthy long-running exploration was reported as
 * a bridge failure. A control tool and a full client-rendered site
 * exploration do not belong on the same clock.
 *
 * Two rules hold this together and are enforced by `assertPolicy` below:
 *
 * - Every budget is a compile-time constant of this module. Nothing here is
 *   derived from the model, the renderer client, page content, or tool
 *   arguments -- a tool that could name its own deadline could also name an
 *   unbounded one.
 * - The outer (renderer) deadline for a tool is always strictly greater
 *   than the inner budget the browser service owns for the same tool, plus
 *   a bounded transport allowance. The layer that does not own the work must
 *   never be the layer that gives up first, or the real typed cause is lost.
 */

/** Absolute bounds any configured budget must fall inside. */
export const TOOL_TIMEOUT_BOUNDS = Object.freeze({
  minInnerBudgetMs: 1_000,
  maxInnerBudgetMs: 120_000,
  minTransportOverheadMs: 500,
  maxTransportOverheadMs: 30_000,
});

export interface ToolTimeoutPolicy {
  /**
   * The total budget `services/browser` owns for this tool's own work --
   * navigation, settle, capture, extraction, contract validation, and
   * cleanup combined. Mirrors the Python-side total for the same tool; the
   * two are checked against each other by the phase's cross-boundary test
   * rather than shared at runtime, since the browser service must stay
   * authoritative over its own scheduling.
   */
  readonly innerBudgetMs: number;
  /**
   * Bounded allowance on top of the inner budget for request transport,
   * response serialization, contract validation, and the service's own
   * bounded cleanup after its inner budget is exhausted. This is what lets
   * the service return a *typed* `TIMEOUT` result instead of having the
   * renderer abort the socket underneath it.
   */
  readonly transportOverheadMs: number;
}

/**
 * Inner budgets mirror `services/browser`'s own per-tool totals:
 *
 * - `browser.explore_website` divides its total across navigation, settle,
 *   capture, extraction, contract validation, and cleanup sub-budgets.
 * - `browser.navigate_and_extract` owns navigation plus HTML extraction.
 * - `browser.get_page_understanding_slice` is an in-memory lookup against an
 *   already-stored observation and never touches a page.
 * - `system.echo` is a control tool and stays bound tightly.
 */
const POLICY_BY_TOOL: Readonly<Record<string, ToolTimeoutPolicy>> = Object.freeze({
  [EXPLORE_WEBSITE_TOOL_NAME]: { innerBudgetMs: 45_000, transportOverheadMs: 15_000 },
  [NAVIGATE_AND_EXTRACT_TOOL_NAME]: { innerBudgetMs: 35_000, transportOverheadMs: 10_000 },
  [GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME]: { innerBudgetMs: 5_000, transportOverheadMs: 5_000 },
  [SYSTEM_ECHO_TOOL_NAME]: { innerBudgetMs: 2_000, transportOverheadMs: 3_000 },
});

/**
 * Applied to a tool this module has no entry for. Deliberately the
 * tightest policy rather than the most generous: an unregistered tool is
 * either a control tool or a mistake, and neither earns an exploration-sized
 * budget.
 */
const FALLBACK_POLICY: ToolTimeoutPolicy = Object.freeze({ innerBudgetMs: 2_000, transportOverheadMs: 3_000 });

export class ToolTimeoutPolicyError extends Error {
  override readonly name = "ToolTimeoutPolicyError";
}

function assertPolicy(toolName: string, policy: ToolTimeoutPolicy): void {
  const { minInnerBudgetMs, maxInnerBudgetMs, minTransportOverheadMs, maxTransportOverheadMs } = TOOL_TIMEOUT_BOUNDS;
  if (!Number.isInteger(policy.innerBudgetMs) || policy.innerBudgetMs < minInnerBudgetMs || policy.innerBudgetMs > maxInnerBudgetMs) {
    throw new ToolTimeoutPolicyError(`Inner budget for '${toolName}' is outside the allowed bounds.`);
  }
  if (
    !Number.isInteger(policy.transportOverheadMs)
    || policy.transportOverheadMs < minTransportOverheadMs
    || policy.transportOverheadMs > maxTransportOverheadMs
  ) {
    throw new ToolTimeoutPolicyError(`Transport overhead for '${toolName}' is outside the allowed bounds.`);
  }
}

for (const [toolName, policy] of Object.entries(POLICY_BY_TOOL)) assertPolicy(toolName, policy);
assertPolicy("<fallback>", FALLBACK_POLICY);

export function toolTimeoutPolicy(toolName: string): ToolTimeoutPolicy {
  return POLICY_BY_TOOL[toolName] ?? FALLBACK_POLICY;
}

/**
 * The outer deadline the renderer applies to one invocation of `toolName`.
 * Strictly greater than the inner budget by construction, which is the
 * ordering P03-R01 step 2 requires.
 */
export function resolveToolTimeoutMs(toolName: string): number {
  const policy = toolTimeoutPolicy(toolName);
  return policy.innerBudgetMs + policy.transportOverheadMs;
}

/** Every tool this policy names, for the cross-boundary ordering test. */
export function policedToolNames(): readonly string[] {
  return Object.freeze(Object.keys(POLICY_BY_TOOL));
}
