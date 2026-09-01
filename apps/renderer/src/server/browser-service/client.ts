import "server-only";

import { z } from "zod";
import {
  EXPLORE_WEBSITE_TOOL_NAME,
  ExploreWebsiteInvocationSchema,
  ExploreWebsiteSuccessResultSchema,
  GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME,
  GetPageUnderstandingSliceInvocationSchema,
  GetPageUnderstandingSliceSuccessResultSchema,
  NAVIGATE_AND_EXTRACT_TOOL_NAME,
  NavigateAndExtractInvocationSchema,
  NavigateAndExtractSuccessResultSchema,
  SYSTEM_ECHO_TOOL_NAME,
  SystemEchoInvocationSchema,
  SystemEchoSuccessResultSchema,
  ToolErrorResultSchema,
  type ExploreWebsiteInvocation,
  type ExploreWebsiteSuccessResult,
  type GetPageUnderstandingSliceInvocation,
  type GetPageUnderstandingSliceSuccessResult,
  type NavigateAndExtractInvocation,
  type NavigateAndExtractSuccessResult,
  type SystemEchoInvocation,
  type SystemEchoSuccessResult,
  type ToolErrorResult,
} from "@ai-browser/contracts";

import {
  BrowserServiceContractError,
  BrowserServiceTimeoutError,
  BrowserServiceUnavailableError,
} from "./errors";
import { redactForLog } from "./redaction";
import { resolveToolTimeoutMs } from "./timeouts";

export interface BrowserServiceClientOptions {
  baseUrl: string;
  serviceToken: string;
  /**
   * Server-owned per-tool deadline resolution (P03-R01 step 1). Deliberately
   * a function of the tool name rather than one scalar: a single budget for
   * every tool is exactly what put a five-second bridge timeout in front of
   * a thirty-second exploration. Overridable only from trusted server code
   * and tests -- the model, the renderer client, page content, and tool
   * arguments cannot reach this constructor.
   */
  resolveTimeoutMs?: (toolName: string) => number;
  fetchImpl?: typeof fetch;
  log?: (record: Record<string, unknown>) => void;
}

/** Every invocation shape `invoke` accepts, keyed by their `toolName` literal. */
export type KnownInvocation = SystemEchoInvocation | NavigateAndExtractInvocation | ExploreWebsiteInvocation | GetPageUnderstandingSliceInvocation;

/** Maps each known tool's `toolName` literal to its success-result type, so `invoke`'s return type is inferred from the invocation passed in. */
interface ToolSuccessResultMap {
  [SYSTEM_ECHO_TOOL_NAME]: SystemEchoSuccessResult;
  [NAVIGATE_AND_EXTRACT_TOOL_NAME]: NavigateAndExtractSuccessResult;
  [EXPLORE_WEBSITE_TOOL_NAME]: ExploreWebsiteSuccessResult;
  [GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME]: GetPageUnderstandingSliceSuccessResult;
}

export type InvokeResult<TInvocation extends KnownInvocation> =
  ToolSuccessResultMap[TInvocation["toolName"]] | ToolErrorResult;

/**
 * Runtime schema registry backing `invoke`'s generic dispatch -- one entry
 * per tool this client knows how to call. Adding a new tool means adding
 * one entry here (its invocation + success-result schemas) and one entry
 * to `ToolSuccessResultMap` above for the inferred return type; nothing
 * else in this class is tool-specific.
 */
const INVOCATION_SCHEMA_BY_TOOL: Record<string, z.ZodTypeAny> = {
  [SYSTEM_ECHO_TOOL_NAME]: SystemEchoInvocationSchema,
  [NAVIGATE_AND_EXTRACT_TOOL_NAME]: NavigateAndExtractInvocationSchema,
  [EXPLORE_WEBSITE_TOOL_NAME]: ExploreWebsiteInvocationSchema,
  [GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME]: GetPageUnderstandingSliceInvocationSchema,
};

const SUCCESS_RESULT_SCHEMA_BY_TOOL: Record<string, z.ZodTypeAny> = {
  [SYSTEM_ECHO_TOOL_NAME]: SystemEchoSuccessResultSchema,
  [NAVIGATE_AND_EXTRACT_TOOL_NAME]: NavigateAndExtractSuccessResultSchema,
  [EXPLORE_WEBSITE_TOOL_NAME]: ExploreWebsiteSuccessResultSchema,
  [GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME]: GetPageUnderstandingSliceSuccessResultSchema,
};

function validateLoopbackBaseUrl(raw: string): URL {
  const url = new URL(raw);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.pathname !== "/") {
    throw new TypeError("Browser service URL must be an origin-only loopback HTTP URL.");
  }
  return url;
}

export class BrowserServiceClient {
  readonly #baseUrl: URL;
  readonly #serviceToken: string;
  readonly #resolveTimeoutMs: (toolName: string) => number;
  readonly #fetch: typeof fetch;
  readonly #log: (record: Record<string, unknown>) => void;

  constructor(options: BrowserServiceClientOptions) {
    this.#baseUrl = validateLoopbackBaseUrl(options.baseUrl);
    if (!options.serviceToken) throw new TypeError("A service token is required.");
    this.#serviceToken = options.serviceToken;
    this.#resolveTimeoutMs = options.resolveTimeoutMs ?? resolveToolTimeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#log = options.log ?? (() => undefined);
  }

  async invoke<TInvocation extends KnownInvocation>(
    invocation: TInvocation,
    signal?: AbortSignal,
  ): Promise<InvokeResult<TInvocation>> {
    const invocationSchema = INVOCATION_SCHEMA_BY_TOOL[invocation.toolName];
    const successResultSchema = SUCCESS_RESULT_SCHEMA_BY_TOOL[invocation.toolName];
    if (!invocationSchema || !successResultSchema) {
      throw new TypeError(`Unknown tool '${invocation.toolName}'.`);
    }
    const payload = invocationSchema.parse(invocation) as TInvocation;
    const deadlineMs = this.#resolveTimeoutMs(invocation.toolName);
    const startedAt = Date.now();
    const timeout = AbortSignal.timeout(deadlineMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    /**
     * P03-R01 step 5. Carries correlation, tool, phase, elapsed, the
     * configured deadline, and a typed failure category -- and nothing
     * else. The service token lives only in the request header and never in
     * this record; arguments, response payloads, and provider/browser
     * exception text are all excluded because any of them may quote
     * untrusted page content.
     */
    const trace = (phase: string, extra: Record<string, unknown> = {}): void => {
      this.#log(redactForLog({
        event: "bridge",
        phase,
        toolName: invocation.toolName,
        ...payload.correlation,
        deadlineMs,
        elapsedMs: Date.now() - startedAt,
        ...extra,
      }) as Record<string, unknown>);
    };
    trace("request");
    let response: Response;
    try {
      response = await this.#fetch(new URL("v1/tools/invoke", this.#baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-service-token": this.#serviceToken,
          "x-request-id": payload.correlation.requestId,
        },
        body: JSON.stringify(payload),
        signal: combinedSignal,
      });
    } catch (error) {
      // Deadline first: when the caller stops a request that had already run
      // out of budget both signals read as aborted, and the exhausted
      // deadline is the cause worth reporting.
      if (timeout.aborted) {
        trace("failed", { failure: "browser_service_timeout" });
        throw new BrowserServiceTimeoutError("Browser service request timed out.", { cause: error });
      }
      if (signal?.aborted) {
        trace("failed", { failure: "cancelled" });
        throw error;
      }
      trace("failed", { failure: "browser_service_unavailable" });
      throw new BrowserServiceUnavailableError("Browser service is unavailable.", { cause: error });
    }
    if (!response.ok) {
      trace("failed", { failure: "browser_service_unavailable", httpStatus: response.status });
      throw new BrowserServiceUnavailableError(`Browser service returned HTTP ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      trace("failed", { failure: "browser_service_contract" });
      throw new BrowserServiceContractError("Browser service returned invalid JSON.", { cause: error });
    }
    const parsed = successResultSchema.or(ToolErrorResultSchema).safeParse(body);
    if (!parsed.success) {
      trace("failed", { failure: "browser_service_contract" });
      throw new BrowserServiceContractError("Browser service response violated the contract.");
    }
    const data = parsed.data as InvokeResult<TInvocation>;
    if (data.correlation.requestId !== payload.correlation.requestId) {
      trace("failed", { failure: "browser_service_contract" });
      throw new BrowserServiceContractError("Browser service response violated the contract.");
    }
    // A structured error the service produced itself is returned unchanged
    // (P03-R01 step 3): its own typed code describes the real cause better
    // than anything this boundary could re-derive from the outside.
    trace("response", {
      status: data.status,
      ...(data.status === "error" ? { failure: "service_reported", errorCode: data.errorCode } : {}),
    });
    return data;
  }
}
