import { z } from "zod";

import {
  UI_SCHEMA_VERSION,
  uiFreshnessSchema,
  uiIdentifierSchema,
  uiSourceReferenceSchema,
  uiTextSchema,
  uiWarningSchema,
} from "./common";

const safeImageUrlSchema = z.string().url().max(2048).refine(
  (value) => new URL(value).protocol === "https:",
  "Product images must use HTTPS",
);

export const productAttributeSchema = z.object({
  name: z.string().min(1).max(80),
  value: z.string().min(1).max(160),
  unit: z.string().min(1).max(24).optional(),
}).strict();

export const productPriceSchema = z.object({
  amount: z.string().regex(/^\d{1,12}(?:\.\d{1,4})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  unit: z.string().min(1).max(40).optional(),
  qualifier: z.string().min(1).max(100).optional(),
}).strict();

export const productResultItemSchema = z.object({
  id: uiIdentifierSchema,
  name: z.string().min(1).max(200),
  price: productPriceSchema.optional(),
  merchant: z.string().min(1).max(120),
  availability: z.string().min(1).max(120),
  image_url: safeImageUrlSchema.optional(),
  attributes: z.array(productAttributeSchema).max(12).default([]),
  source_ids: z.array(uiIdentifierSchema).min(1).max(10),
  partial_data_warnings: z.array(z.string().min(1).max(240)).max(8).default([]),
}).strict();

export const productResultPropsSchema = z.object({
  component_instance_id: uiIdentifierSchema,
  query: z.string().max(300),
  items: z.array(productResultItemSchema).max(50),
  sources: z.array(uiSourceReferenceSchema).min(1).max(30),
  freshness: uiFreshnessSchema,
  warnings: z.array(uiWarningSchema).max(10).default([]),
}).strict();

export const productCommandSchema = z.discriminatedUnion("command_type", [
  z.object({
    command_type: z.literal("product.refresh"),
    schema_version: z.literal(UI_SCHEMA_VERSION),
    component_instance_id: uiIdentifierSchema,
    query_state: z.object({ query: z.string().max(300), filter: z.string().max(200), sort: z.enum(["default", "name", "price"]) }).strict(),
  }).strict(),
  z.object({
    command_type: z.literal("product.filter"),
    schema_version: z.literal(UI_SCHEMA_VERSION),
    component_instance_id: uiIdentifierSchema,
    query_state: z.object({ query: z.string().max(300), filter: z.string().max(200), sort: z.enum(["default", "name", "price"]) }).strict(),
  }).strict(),
]);

export const rawProductResultSchema = productResultPropsSchema.extend({
  items: z.array(productResultItemSchema).max(200),
}).strict();

export type ProductResultProps = z.infer<typeof productResultPropsSchema>;
export type ProductResultItem = z.infer<typeof productResultItemSchema>;
export type ProductCommand = z.infer<typeof productCommandSchema>;
export type ProductSort = ProductCommand["query_state"]["sort"];

