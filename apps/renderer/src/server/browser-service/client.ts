import "server-only";

import {
  SystemEchoInvocationSchema,
  SystemEchoSuccessResultSchema,
  ToolErrorResultSchema,
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

export type InvokeResult = SystemEchoSuccessResult | ToolErrorResult;

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

  async invoke(invocation: SystemEchoInvocation, signal?: AbortSignal): Promise<InvokeResult> {
    const payload = SystemEchoInvocationSchema.parse(invocation);
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
    const parsed = SystemEchoSuccessResultSchema.or(ToolErrorResultSchema).safeParse(body);
    if (!parsed.success || parsed.data.correlation.requestId !== payload.correlation.requestId) {
      throw new BrowserServiceContractError("Browser service response violated the contract.");
    }
    this.#log(redactForLog({ event: "bridge.response", ...parsed.data.correlation, status: parsed.data.status }) as Record<string, unknown>);
    return parsed.data;
  }
}
