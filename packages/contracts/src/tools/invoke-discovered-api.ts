import { z } from "zod";
import { HttpUrlSchema, IsoDateTimeSchema } from "../primitives";
import { ToolDefinitionSchema } from "../tool-definition";

export const INVOKE_DISCOVERED_API_TOOL_NAME = "browser.invoke_discovered_api" as const;

const logicalScalarSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const DiscoveredApiLogicalValueSchema = z.union([
  logicalScalarSchema,
  z.array(logicalScalarSchema).max(50),
]);

export const InvokeDiscoveredApiArgsSchema = z.object({
  siteId: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
  operationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  parameters: z.record(z.string().min(1).max(80), DiscoveredApiLogicalValueSchema)
    .refine((value) => Object.keys(value).length <= 50, "Too many parameters"),
}).strict();

export const DiscoveredApiRecordValueSchema = z.union([
  logicalScalarSchema,
  z.array(logicalScalarSchema).max(50),
  z.record(z.string().min(1).max(80), logicalScalarSchema)
    .refine((value) => Object.keys(value).length <= 50, "Too many object fields"),
]);

export const DiscoveredApiRecordSchema = z.record(
  z.string().min(1).max(80),
  DiscoveredApiRecordValueSchema,
).refine((value) => Object.keys(value).length <= 80, "Too many record fields");

export const DiscoveredApiSourceSchema = z.object({
  sourceId: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  url: HttpUrlSchema,
}).strict();

export const InvokeDiscoveredApiResultSchema = z.object({
  siteId: z.string().min(1).max(80),
  operationId: z.string().min(1).max(128),
  mapVersion: z.string().min(1).max(128),
  resultKind: z.enum(["product_results", "flight_comparison", "generic_records"]),
  records: z.array(DiscoveredApiRecordSchema).max(100),
  sources: z.array(DiscoveredApiSourceSchema).min(1).max(30),
  retrievedAt: IsoDateTimeSchema,
  staleAfter: IsoDateTimeSchema.optional(),
  warnings: z.array(z.string().min(1).max(300)).max(20),
  redacted: z.boolean(),
  truncated: z.boolean(),
  untrusted: z.literal(true),
}).strict();

export const InvokeDiscoveredApiToolDefinition = ToolDefinitionSchema.parse({
  contractVersion: 1,
  name: INVOKE_DISCOVERED_API_TOOL_NAME,
  description: "Invokes one approved read-only discovered API operation using typed logical parameters.",
  argsSchemaVersion: 1,
  argsSchemaRef: "browser.invoke_discovered_api.v1",
  sensitiveByDefault: false,
});

export type InvokeDiscoveredApiArgs = z.infer<typeof InvokeDiscoveredApiArgsSchema>;
export type InvokeDiscoveredApiResult = z.infer<typeof InvokeDiscoveredApiResultSchema>;
