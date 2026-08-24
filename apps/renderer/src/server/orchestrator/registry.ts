import "server-only";

import {
  CONTRACT_MAJOR_VERSION,
  MAX_URL_LENGTH,
  NAVIGATE_AND_EXTRACT_TOOL_NAME,
  NavigateAndExtractArgsSchema,
  NavigateAndExtractInvocationSchema,
  NavigateAndExtractSuccessResultSchema,
  SYSTEM_ECHO_TOOL_NAME,
  SystemEchoArgsSchema,
  SystemEchoInvocationSchema,
  SystemEchoSuccessResultSchema,
  ToolErrorResultSchema,
  type NavigateAndExtractInvocation,
  type SystemEchoInvocation,
} from "@ai-browser/contracts";
import type { MistralToolDefinition } from "../ai/mistral";

export interface EchoToolExecutor {
  invoke(invocation: SystemEchoInvocation, signal?: AbortSignal): Promise<unknown>;
}

export interface RegisteredTool {
  readonly definition: MistralToolDefinition;
  readonly sensitive: false;
  parseArguments(value: unknown): unknown;
  execute(args: unknown, context: ToolExecutionContext): Promise<unknown>;
}

export interface ToolExecutionContext {
  requestId: string;
  userId: string;
  sessionId: string;
  invocationId: string;
  signal: AbortSignal;
}

export function createPhaseOneToolRegistry(executor: EchoToolExecutor): ReadonlyMap<string, RegisteredTool> {
  const echo: RegisteredTool = {
    definition: {
      name: SYSTEM_ECHO_TOOL_NAME,
      description: "Echo a message through the local stub bridge.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: { message: { type: "string", minLength: 1, maxLength: 2000 } },
      },
    },
    sensitive: false,
    parseArguments: (value) => SystemEchoArgsSchema.parse(value),
    async execute(args, context) {
      const invocation = SystemEchoInvocationSchema.parse({
        contractVersion: CONTRACT_MAJOR_VERSION,
        correlation: {
          requestId: context.requestId,
          userId: context.userId,
          sessionId: context.sessionId,
        },
        toolCallId: context.invocationId,
        toolName: SYSTEM_ECHO_TOOL_NAME,
        arguments: args,
      });
      const result = await executor.invoke(invocation, context.signal);
      return SystemEchoSuccessResultSchema.or(ToolErrorResultSchema).parse(result);
    },
  };
  return new Map([[SYSTEM_ECHO_TOOL_NAME, echo]]);
}

export interface NavigateAndExtractToolExecutor {
  invoke(invocation: NavigateAndExtractInvocation, signal?: AbortSignal): Promise<unknown>;
}

/**
 * Registers the read-only `browser.navigate_and_extract` tool (P02-F04).
 * URL-only input, never sensitive, and its arguments/result are validated
 * against the exact same contract schemas the browser service itself
 * validates against -- see `services/browser/src/browser_service/tools/navigate_and_extract.py`.
 */
export function createNavigateAndExtractTool(executor: NavigateAndExtractToolExecutor): RegisteredTool {
  return {
    definition: {
      name: NAVIGATE_AND_EXTRACT_TOOL_NAME,
      description:
        "Navigates to a public http(s) URL and returns bounded, structured, citable page content. " +
        "Read-only: never fills forms, clicks, submits, or uses authenticated sessions.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri", maxLength: MAX_URL_LENGTH },
        },
      },
    },
    sensitive: false,
    parseArguments: (value) => NavigateAndExtractArgsSchema.parse(value),
    async execute(args, context) {
      const invocation = NavigateAndExtractInvocationSchema.parse({
        contractVersion: CONTRACT_MAJOR_VERSION,
        correlation: {
          requestId: context.requestId,
          userId: context.userId,
          sessionId: context.sessionId,
        },
        toolCallId: context.invocationId,
        toolName: NAVIGATE_AND_EXTRACT_TOOL_NAME,
        arguments: args,
      });
      const result = await executor.invoke(invocation, context.signal);
      return NavigateAndExtractSuccessResultSchema.or(ToolErrorResultSchema).parse(result);
    },
  };
}

/**
 * Builds the full tool registry from whichever executors are actually
 * available -- e.g. a `.env`/desktop-launch environment without the
 * browser service configured simply omits `browser.navigate_and_extract`
 * rather than failing the whole chat endpoint. A single
 * `BrowserServiceClient` instance satisfies both executor interfaces
 * (see `server/browser-service/client.ts`), so callers typically pass
 * the same client for both.
 */
export function createToolRegistry(options: {
  echoExecutor?: EchoToolExecutor;
  navigateAndExtractExecutor?: NavigateAndExtractToolExecutor;
}): ReadonlyMap<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  if (options.echoExecutor) {
    for (const [name, tool] of createPhaseOneToolRegistry(options.echoExecutor)) {
      tools.set(name, tool);
    }
  }
  if (options.navigateAndExtractExecutor) {
    tools.set(NAVIGATE_AND_EXTRACT_TOOL_NAME, createNavigateAndExtractTool(options.navigateAndExtractExecutor));
  }
  return tools;
}
