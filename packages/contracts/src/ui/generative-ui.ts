import { z } from "zod";
import {
  UI_SCHEMA_VERSION,
  uiCommandDescriptorSchema,
  uiFreshnessSchema,
  uiIdentifierSchema,
  uiProvenanceSchema,
  uiWarningSchema,
} from "./common";
import { productResultPropsSchema } from "./product-result";
import { flightComparisonPropsSchema } from "./flight-comparison";

const envelopeFields = {
  schema_version: z.literal(UI_SCHEMA_VERSION),
  instance_id: uiIdentifierSchema,
  result_digest: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: uiProvenanceSchema,
  allowed_commands: z.array(uiCommandDescriptorSchema).max(5),
  correlation_id: uiIdentifierSchema,
  freshness: uiFreshnessSchema,
  warnings: z.array(uiWarningSchema).max(20).default([]),
  fallback_text: z.string().min(1).max(10_000),
};

export const productGenerativeUiPartSchema = z.object({
  component_type: z.literal("product_results"),
  ...envelopeFields,
  props: productResultPropsSchema,
}).strict();

export const flightGenerativeUiPartSchema = z.object({
  component_type: z.literal("flight_comparison"),
  ...envelopeFields,
  props: flightComparisonPropsSchema,
}).strict();

export const generativeUiPartSchema = z.discriminatedUnion("component_type", [
  productGenerativeUiPartSchema,
  flightGenerativeUiPartSchema,
]);

export type ProductGenerativeUiPart = z.infer<typeof productGenerativeUiPartSchema>;
export type FlightGenerativeUiPart = z.infer<typeof flightGenerativeUiPartSchema>;
export type GenerativeUiPart = z.infer<typeof generativeUiPartSchema>;
