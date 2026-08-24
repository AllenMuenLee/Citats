import "server-only";

import { z } from "zod";
import {
  NAVIGATE_AND_EXTRACT_TOOL_NAME,
  NavigateAndExtractInvocationSchema,
  NavigateAndExtractSuccessResultSchema,
  SYSTEM_ECHO_TOOL_NAME,
  SystemEchoInvocationSchema,
  SystemEchoSuccessResultSchema,
  ToolErrorResultSchema,
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

export interface BrowserServiceClientOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (record: Record<string, unknown>) => void;
}

/** Every invocation shape `invoke` accepts, keyed by their `toolName` literal. */
export type KnownInvocation = SystemEchoInvocation | NavigateAndExtractInvocation;

/** Maps each known tool's `toolName` literal to its success-result type, so `invoke`'s return type is inferred from the invocation passed in. */
interface ToolSuccessResultMap {
  [SYSTEM_ECHO_TOOL_NAME]: SystemEchoSuccessResult;
  [NAVIGATE_AND_EXTRACT_TOOL_NAME]: NavigateAndExtractSuccessResult;
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
};

const SUCCESS_RESULT_SCHEMA_BY_TOOL: Record<string, z.ZodTypeAny> = {
  [SYSTEM_ECHO_TOOL_NAME]: SystemEchoSuccessResultSchema,
  [NAVIGATE_AND_EXTRACT_TOOL_NAME]: NavigateAndExtractSuccessResultSchema,
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
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #log: (record: Record<string, unknown>) => void;

  constructor(options: BrowserServiceClientOptions) {
    this.#baseUrl = validateLoopbackBaseUrl(options.baseUrl);
    if (!options.serviceToken) throw new TypeError("A service token is required.");
    this.#serviceToken = options.serviceToken;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
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
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    this.#log(redactForLog({ event: "bridge.request", ...payload.correlation }) as Record<string, unknown>);
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
      if (timeout.aborted) throw new BrowserServiceTimeoutError("Browser service request timed out.", { cause: error });
      if (signal?.aborted) throw error;
      throw new BrowserServiceUnavailableError("Browser service is unavailable.", { cause: error });
    }
    if (!response.ok) {
      throw new BrowserServiceUnavailableError(`Browser service returned HTTP ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new BrowserServiceContractError("Browser service returned invalid JSON.", { cause: error });
    }
    const parsed = successResultSchema.or(ToolErrorResultSchema).safeParse(body);
    if (!parsed.success) {
      throw new BrowserServiceContractError("Browser service response violated the contract.");
    }
    const data = parsed.data as InvokeResult<TInvocation>;
    if (data.correlation.requestId !== payload.correlation.requestId) {
      throw new BrowserServiceContractError("Browser service response violated the contract.");
    }
    this.#log(redactForLog({ event: "bridge.response", ...data.correlation, status: data.status }) as Record<string, unknown>);
    return data;
  }
}
