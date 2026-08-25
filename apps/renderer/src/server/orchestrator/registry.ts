import "server-only";

import {
  CONTRACT_MAJOR_VERSION,
  MAX_URL_LENGTH,
  NAVIGATE_AND_EXTRACT_TOOL_NAME,
  NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME,
  NAVIGATE_EXTRACT_AND_DISCOVER_GOAL_MAX_LENGTH,
  INVOKE_DISCOVERED_API_TOOL_NAME,
  InvokeDiscoveredApiArgsSchema,
  InvokeDiscoveredApiInvocationSchema,
  InvokeDiscoveredApiSuccessResultSchema,
  NavigateAndExtractArgsSchema,
  NavigateAndExtractInvocationSchema,
  NavigateAndExtractSuccessResultSchema,
  NavigateExtractAndDiscoverArgsSchema,
  NavigateExtractAndDiscoverInvocationSchema,
  NavigateExtractAndDiscoverSuccessResultSchema,
  SYSTEM_ECHO_TOOL_NAME,
  SystemEchoArgsSchema,
  SystemEchoInvocationSchema,
  SystemEchoSuccessResultSchema,
  ToolErrorResultSchema,
  type NavigateAndExtractInvocation,
  type NavigateExtractAndDiscoverInvocation,
  type InvokeDiscoveredApiInvocation,
  type SystemEchoInvocation,
} from "@ai-browser/contracts";
import type { MistralToolDefinition } from "../ai/mistral";
import type { DiscoveredTool } from "../browser-service/client";

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

export interface NavigateExtractAndDiscoverToolExecutor {
  invoke(invocation: NavigateExtractAndDiscoverInvocation, signal?: AbortSignal): Promise<unknown>;
}

export interface InvokeDiscoveredApiToolExecutor {
  invoke(invocation: InvokeDiscoveredApiInvocation, signal?: AbortSignal): Promise<unknown>;
}

export function createInvokeDiscoveredApiTool(executor: InvokeDiscoveredApiToolExecutor): RegisteredTool {
  return {
    definition: {
      name: INVOKE_DISCOVERED_API_TOOL_NAME,
      description: "Invokes an approved read-only discovered API operation using logical parameters. Never accepts URLs, headers, cookies, or mutation methods.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["siteId", "operationId", "parameters"],
        properties: {
          siteId: { type: "string", minLength: 1, maxLength: 80 },
          operationId: { type: "string", minLength: 1, maxLength: 128 },
          parameters: { type: "object", additionalProperties: true, maxProperties: 50 },
        },
      },
    },
    sensitive: false,
    parseArguments: (value) => InvokeDiscoveredApiArgsSchema.parse(value),
    async execute(args, context) {
      const invocation = InvokeDiscoveredApiInvocationSchema.parse({
        contractVersion: CONTRACT_MAJOR_VERSION,
        correlation: {
          requestId: context.requestId,
          userId: context.userId,
          sessionId: context.sessionId,
        },
        toolCallId: context.invocationId,
        toolName: INVOKE_DISCOVERED_API_TOOL_NAME,
        arguments: args,
      });
      const result = await executor.invoke(invocation, context.signal);
      return InvokeDiscoveredApiSuccessResultSchema.or(ToolErrorResultSchema).parse(result);
    },
  };
}

function dynamicDiscoveredToolName(definition: DiscoveredTool): string {
  const site = definition.siteId.replaceAll("-", "_").replace(/[^a-z0-9_]/g, "");
  const operation = definition.operationId.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return `discovered.${site}.${operation}`.slice(0, 64);
}

export function createDiscoveredOperationTool(
  executor: InvokeDiscoveredApiToolExecutor,
  discovered: DiscoveredTool,
): RegisteredTool {
  return {
    definition: {
      name: dynamicDiscoveredToolName(discovered),
      description: `Read-only ${discovered.resultKind.replaceAll("_", " ")} operation approved for ${discovered.siteId}.`,
      parameters: discovered.parameters,
    },
    sensitive: false,
    parseArguments(value) {
      return InvokeDiscoveredApiArgsSchema.parse({
        siteId: discovered.siteId,
        operationId: discovered.operationId,
        parameters: value,
      }).parameters;
    },
    async execute(parameters, context) {
      const invocation = InvokeDiscoveredApiInvocationSchema.parse({
        contractVersion: CONTRACT_MAJOR_VERSION,
        correlation: { requestId: context.requestId, userId: context.userId, sessionId: context.sessionId },
        toolCallId: context.invocationId,
        toolName: INVOKE_DISCOVERED_API_TOOL_NAME,
        arguments: {
          siteId: discovered.siteId,
          operationId: discovered.operationId,
          parameters,
        },
      });
      const result = await executor.invoke(invocation, context.signal);
      return InvokeDiscoveredApiSuccessResultSchema.or(ToolErrorResultSchema).parse(result);
    },
  };
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
 * Registers the read-only `browser.navigate_extract_and_discover` tool
 * (P03-F05). URL + a bounded free-text goal, never sensitive. Its result
 * carries a `document`/`discovery` split -- see
 * `services/browser/src/browser_service/tools/navigate_extract_and_discover.py`.
 * `ChatOrchestrator` (not this factory) is responsible for turning any
 * newly-active `discovery.operations` a call to this tool returns into
 * `discovered.*` tools available for the rest of that same run -- see
 * `orchestrator.ts`'s mid-run catalog refresh.
 */
export function createNavigateExtractAndDiscoverTool(
  executor: NavigateExtractAndDiscoverToolExecutor,
): RegisteredTool {
  return {
    definition: {
      name: NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME,
      description:
        "Navigates to a public http(s) URL, reads bounded page content, and observes the page's own " +
        "read-only network traffic to surface newly available read-only API operations for this " +
        "session. Read-only: never fills forms, clicks, submits, or executes any mutating request. " +
        "Prefer this over browser.navigate_and_extract when you expect the page to expose structured " +
        "data (search results, listings, schedules) you may want to query directly afterward via the " +
        "discovered.* tools this call can make available. Any action-affordance it reports is " +
        "informational only and is never itself callable.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri", maxLength: MAX_URL_LENGTH },
          goal: { type: "string", maxLength: NAVIGATE_EXTRACT_AND_DISCOVER_GOAL_MAX_LENGTH },
        },
      },
    },
    sensitive: false,
    parseArguments: (value) => NavigateExtractAndDiscoverArgsSchema.parse(value),
    async execute(args, context) {
      const invocation = NavigateExtractAndDiscoverInvocationSchema.parse({
        contractVersion: CONTRACT_MAJOR_VERSION,
        correlation: {
          requestId: context.requestId,
          userId: context.userId,
          sessionId: context.sessionId,
        },
        toolCallId: context.invocationId,
        toolName: NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME,
        arguments: args,
      });
      const result = await executor.invoke(invocation, context.signal);
      return NavigateExtractAndDiscoverSuccessResultSchema.or(ToolErrorResultSchema).parse(result);
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
  navigateExtractAndDiscoverExecutor?: NavigateExtractAndDiscoverToolExecutor;
  invokeDiscoveredApiExecutor?: InvokeDiscoveredApiToolExecutor;
  discoveredApiDefinitions?: readonly DiscoveredTool[];
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
  if (options.navigateExtractAndDiscoverExecutor) {
    tools.set(
      NAVIGATE_EXTRACT_AND_DISCOVER_TOOL_NAME,
      createNavigateExtractAndDiscoverTool(options.navigateExtractAndDiscoverExecutor),
    );
  }
  if (options.invokeDiscoveredApiExecutor) {
    tools.set(INVOKE_DISCOVERED_API_TOOL_NAME, createInvokeDiscoveredApiTool(options.invokeDiscoveredApiExecutor));
    for (const definition of options.discoveredApiDefinitions ?? []) {
      const tool = createDiscoveredOperationTool(options.invokeDiscoveredApiExecutor, definition);
      tools.set(tool.definition.name, tool);
    }
  }
  return tools;
}
