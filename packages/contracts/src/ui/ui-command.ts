import { z } from "zod";

import { UI_SCHEMA_VERSION, uiIdentifierSchema } from "./common";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idempotencyKeySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const querySchema = z.string().trim().min(1).max(500);

const envelope = {
  schema_version: z.literal(UI_SCHEMA_VERSION),
  component_instance_id: uiIdentifierSchema,
  originating_result_digest: digestSchema,
  correlation_id: uiIdentifierSchema,
  idempotency_key: idempotencyKeySchema.optional(),
};

export const productRefreshArgumentsSchema = z.object({ query: querySchema }).strict();
export const productFilterArgumentsSchema = z.object({
  query: querySchema,
  merchant: z.string().trim().min(1).max(100).optional(),
  availability: z.enum(["available", "unavailable", "unknown"]).optional(),
  min_price: z.number().finite().nonnegative().optional(),
  max_price: z.number().finite().nonnegative().optional(),
}).strict().refine((value) => value.min_price === undefined || value.max_price === undefined || value.min_price <= value.max_price, "min_price must not exceed max_price");

export const flightRefreshArgumentsSchema = z.object({ query: querySchema }).strict();
export const flightFilterArgumentsSchema = z.object({
  query: querySchema,
  max_stops: z.number().int().min(0).max(4).optional(),
  departure_window: z.enum(["morning", "afternoon", "evening", "overnight"]).optional(),
  max_price: z.number().finite().nonnegative().optional(),
}).strict();
export const flightDetailArgumentsSchema = z.object({ itinerary_id: uiIdentifierSchema }).strict();

export const uiCommandArgumentSchemas = {
  "product.refresh": productRefreshArgumentsSchema,
  "product.filter": productFilterArgumentsSchema,
  "flight.refresh": flightRefreshArgumentsSchema,
  "flight.filter": flightFilterArgumentsSchema,
  "flight.detail": flightDetailArgumentsSchema,
} as const;

function command<T extends keyof typeof uiCommandArgumentSchemas>(componentType: "product_results" | "flight_comparison", commandType: T) {
  return z.object({
    ...envelope,
    component_type: z.literal(componentType),
    command_type: z.literal(commandType),
    arguments: uiCommandArgumentSchemas[commandType],
  }).strict();
}

export const productRefreshCommandSchema = command("product_results", "product.refresh");
export const productFilterCommandSchema = command("product_results", "product.filter");
export const flightRefreshCommandSchema = command("flight_comparison", "flight.refresh");
export const flightFilterCommandSchema = command("flight_comparison", "flight.filter");
export const flightDetailCommandSchema = command("flight_comparison", "flight.detail");

export const uiCommandSchema = z.discriminatedUnion("command_type", [
  productRefreshCommandSchema,
  productFilterCommandSchema,
  flightRefreshCommandSchema,
  flightFilterCommandSchema,
  flightDetailCommandSchema,
]);

export const uiCommandFailureSchema = z.object({
  ok: z.literal(false),
  code: z.enum(["unauthenticated", "forbidden", "csrf_failed", "expired", "stale", "invalid_command", "invalid_arguments", "rate_limited"]),
  message: z.string().min(1).max(300),
  refresh_required: z.boolean(),
  retry_after_ms: z.number().int().nonnegative().optional(),
}).strict();

export const uiCommandSuccessSchema = z.object({
  ok: z.literal(true),
  component_instance_id: uiIdentifierSchema,
  correlation_id: uiIdentifierSchema,
  relationship: z.enum(["replace", "append"]),
  result: z.unknown(),
  provenance: z.object({
    invocation_id: uiIdentifierSchema,
    source_ids: z.array(uiIdentifierSchema).min(1).max(30),
  }).strict(),
  replayed: z.boolean(),
}).strict();

export const uiCommandResultSchema = z.union([uiCommandSuccessSchema, uiCommandFailureSchema]);

export type UiCommand = z.infer<typeof uiCommandSchema>;
export type UiCommandType = UiCommand["command_type"];
export type UiCommandResult = z.infer<typeof uiCommandResultSchema>;
