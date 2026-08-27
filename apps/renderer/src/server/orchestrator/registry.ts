import "server-only";

import {
  CONTRACT_MAJOR_VERSION,
  EXPLORE_WEBSITE_TOOL_NAME,
  ExploreWebsiteArgsSchema,
  ExploreWebsiteInvocationSchema,
  ExploreWebsiteSuccessResultSchema,
  GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME,
  GetPageUnderstandingSliceArgsSchema,
  GetPageUnderstandingSliceInvocationSchema,
  GetPageUnderstandingSliceSuccessResultSchema,
  PROPOSE_GENERATIVE_UI_PLAN_TOOL_NAME,
  ProposeGenerativeUiPlanArgsSchema,
  ProposeGenerativeUiPlanInvocationSchema,
  ProposeGenerativeUiPlanSuccessResultSchema,
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
  type ExploreWebsiteInvocation,
  type GetPageUnderstandingSliceInvocation,
  type NavigateAndExtractInvocation,
  type ProposeGenerativeUiPlanInvocation,
  type SystemEchoInvocation,
} from "@ai-browser/contracts";
import type { ModelToolDefinition } from "../ai";

/**
 * `format: "uri"` is deliberately absent. Groq validates tool schemas against
 * the structured-output format allowlist (date-time, time, date, duration,
 * email, hostname, ipv4, ipv6, uuid) and rejects anything else outright, so
 * declaring it made every tool-carrying request fail before the model saw it.
 * `pattern` is supported by both providers and already carries the same
 * constraint, so nothing is lost by expressing it that way alone.
 */
const HTTP_URL_JSON_SCHEMA = {
  type: "string", pattern: "^https?://", maxLength: MAX_URL_LENGTH,
} as const;

/**
 * Groq's strict tool schemas require every declared property to be listed in
 * `required`, so a genuinely optional argument is declared nullable rather
 * than left out. A `null` the model then sends for one is the absence of a
 * value, not a value, and is dropped here so the contract schema -- which
 * models absence as `undefined` -- never sees it.
 */
function withoutNull(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record[key] !== null) return value;
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

const OPAQUE_HANDLE_JSON_SCHEMA = {
  type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$",
} as const;

const UI_SOURCE_FIELD_ROLES = [
  "title", "description", "image", "audio", "video", "price", "rating", "date",
  "amenity", "availability", "provider", "action",
] as const;

const GENERATIVE_UI_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "observationId", "layoutKind", "sourceCollectionHandles", "selectedFields", "groupBy",
    "orderBy", "filters", "detailRegionHandles", "mediaPlacement", "provenance", "freshness",
    "warnings", "localInteractionIntents", "externalWorkflowIntents",
  ],
  properties: {
    observationId: OPAQUE_HANDLE_JSON_SCHEMA,
    layoutKind: { enum: ["list", "grid", "card_grid", "table", "comparison", "gallery", "timeline", "map", "detail", "generic_collection", "cited_text"] },
    sourceCollectionHandles: { type: "array", maxItems: 10, items: OPAQUE_HANDLE_JSON_SCHEMA },
    selectedFields: { type: "array", maxItems: 24, items: { enum: UI_SOURCE_FIELD_ROLES } },
    groupBy: { anyOf: [{ enum: UI_SOURCE_FIELD_ROLES }, { type: "null" }] },
    orderBy: { anyOf: [
      { type: "object", additionalProperties: false, required: ["field", "direction"], properties: { field: { enum: UI_SOURCE_FIELD_ROLES }, direction: { enum: ["asc", "desc"] } } },
      { type: "null" },
    ] },
    filters: { type: "array", maxItems: 10, items: {
      type: "object", additionalProperties: false, required: ["field", "operator", "value"],
      properties: { field: { enum: UI_SOURCE_FIELD_ROLES }, operator: { enum: ["equals", "contains", "range", "exists"] }, value: { anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }] } },
    } },
    detailRegionHandles: { type: "array", maxItems: 5, items: OPAQUE_HANDLE_JSON_SCHEMA },
    mediaPlacement: { enum: ["leading", "trailing", "background", "none"] },
    provenance: { type: "object", additionalProperties: false, required: ["sourceUrl", "retrievedAt"], properties: { sourceUrl: HTTP_URL_JSON_SCHEMA, retrievedAt: { type: "string", format: "date-time" } } },
    freshness: { enum: ["live", "cached", "unknown"] },
    warnings: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } },
    localInteractionIntents: { type: "array", maxItems: 10, items: OPAQUE_HANDLE_JSON_SCHEMA },
    externalWorkflowIntents: { type: "array", maxItems: 10, items: OPAQUE_HANDLE_JSON_SCHEMA },
  },
} as const;

export interface EchoToolExecutor {
  invoke(invocation: SystemEchoInvocation, signal?: AbortSignal): Promise<unknown>;
}

export interface RegisteredTool {
  readonly definition: ModelToolDefinition;
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
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: {
          message: { type: "string", minLength: 1, maxLength: 2000 },
          context: { type: "object", maxProperties: 20, additionalProperties: true },
          credentialHandle: { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:-]+$" },
        },
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

export interface PhaseThreeToolExecutor {
  invoke(invocation: ExploreWebsiteInvocation | GetPageUnderstandingSliceInvocation | ProposeGenerativeUiPlanInvocation, signal?: AbortSignal): Promise<unknown>;
}

function createPhaseThreeTool(
  name: string,
  argsSchema: { parse(value: unknown): unknown },
  invocationSchema: { parse(value: unknown): ExploreWebsiteInvocation | GetPageUnderstandingSliceInvocation | ProposeGenerativeUiPlanInvocation },
  resultSchema: { or(other: typeof ToolErrorResultSchema): { parse(value: unknown): unknown } },
  executor: PhaseThreeToolExecutor,
  description: string,
  parameters: Record<string, unknown>,
): RegisteredTool {
  return {
    definition: { name, description, strict: true, parameters },
    sensitive: false,
    parseArguments: (value) => argsSchema.parse(value),
    async execute(args, context) {
      const invocation = invocationSchema.parse({ contractVersion: CONTRACT_MAJOR_VERSION,
        correlation: { requestId: context.requestId, userId: context.userId, sessionId: context.sessionId },
        toolCallId: context.invocationId, toolName: name, arguments: args });
      return resultSchema.or(ToolErrorResultSchema).parse(await executor.invoke(invocation, context.signal));
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
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: HTTP_URL_JSON_SCHEMA,
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
 * rather than failing the whole chat endpoint.
 */
export function createToolRegistry(options: {
  echoExecutor?: EchoToolExecutor;
  navigateAndExtractExecutor?: NavigateAndExtractToolExecutor;
  phaseThreeExecutor?: PhaseThreeToolExecutor;
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
  if (options.phaseThreeExecutor) {
    tools.set(EXPLORE_WEBSITE_TOOL_NAME, createPhaseThreeTool(EXPLORE_WEBSITE_TOOL_NAME, {
      parse: (value) => ExploreWebsiteArgsSchema.parse(withoutNull(value, "goal")),
    }, ExploreWebsiteInvocationSchema, ExploreWebsiteSuccessResultSchema, options.phaseThreeExecutor, "Observe a public rendered website as bounded, untrusted evidence and capabilities.", {
      type: "object", additionalProperties: false, required: ["url", "goal"],
      properties: { url: HTTP_URL_JSON_SCHEMA, goal: { anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }] } },
    }));
    tools.set(GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME, createPhaseThreeTool(GET_PAGE_UNDERSTANDING_SLICE_TOOL_NAME, GetPageUnderstandingSliceArgsSchema, GetPageUnderstandingSliceInvocationSchema, GetPageUnderstandingSliceSuccessResultSchema, options.phaseThreeExecutor, "Retrieve an owned bounded page-understanding slice.", {
      type: "object", additionalProperties: false, required: ["observationId", "handle"], properties: { observationId: OPAQUE_HANDLE_JSON_SCHEMA, handle: OPAQUE_HANDLE_JSON_SCHEMA },
    }));
    tools.set(PROPOSE_GENERATIVE_UI_PLAN_TOOL_NAME, createPhaseThreeTool(PROPOSE_GENERATIVE_UI_PLAN_TOOL_NAME, ProposeGenerativeUiPlanArgsSchema, ProposeGenerativeUiPlanInvocationSchema, ProposeGenerativeUiPlanSuccessResultSchema, options.phaseThreeExecutor, "Validate declarative display intent without rendering or execution.", GENERATIVE_UI_PLAN_JSON_SCHEMA));
  }
  return tools;
}
