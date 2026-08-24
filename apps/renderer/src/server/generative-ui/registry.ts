import {
  flightComparisonPropsSchema,
  flightDetailArgumentsSchema,
  flightFilterArgumentsSchema,
  flightRefreshArgumentsSchema,
  generativeUiPartSchema,
  productFilterArgumentsSchema,
  productRefreshArgumentsSchema,
  productResultPropsSchema,
  type GenerativeUiPart,
} from "@ai-browser/contracts";
import type { z } from "zod";
import { createValidationFallback, type GenerativeUiFallback } from "./fallback";
import { formatFlightComparisonFallback, transformFlightComparison } from "./flight-comparison";
import { formatProductResultFallback, transformProductResult } from "./product-results";

type RegistryEntry = {
  propsSchema: z.ZodType;
  commandSchemas: Readonly<Record<string, z.ZodType>>;
  transform: (input: unknown) => unknown;
  formatFallback: (input: never) => string;
};

export const serverGenerativeUiRegistry = {
  "product_results@1.0": {
    propsSchema: productResultPropsSchema,
    commandSchemas: {
      "product.refresh": productRefreshArgumentsSchema,
      "product.filter": productFilterArgumentsSchema,
    },
    transform: transformProductResult,
    formatFallback: formatProductResultFallback,
  },
  "flight_comparison@1.0": {
    propsSchema: flightComparisonPropsSchema,
    commandSchemas: {
      "flight.refresh": flightRefreshArgumentsSchema,
      "flight.filter": flightFilterArgumentsSchema,
      "flight.detail": flightDetailArgumentsSchema,
    },
    transform: transformFlightComparison,
    formatFallback: formatFlightComparisonFallback,
  },
} as const satisfies Record<string, RegistryEntry>;

export type ServerGenerativeUiRegistryKey = keyof typeof serverGenerativeUiRegistry;

export type ServerGenerativeUiValidation =
  | { ok: true; part: GenerativeUiPart }
  | { ok: false; fallback: GenerativeUiFallback };

function diagnosticFields(input: unknown) {
  if (!input || typeof input !== "object") return { text: "The structured result is unavailable." };
  const record = input as Record<string, unknown>;
  return {
    componentType: typeof record.component_type === "string" ? record.component_type : undefined,
    schemaVersion: typeof record.schema_version === "string" ? record.schema_version : undefined,
    text: typeof record.fallback_text === "string" ? record.fallback_text : "The structured result is unavailable.",
  };
}

export function validateGenerativeUiPart(input: unknown): ServerGenerativeUiValidation {
  const parsed = generativeUiPartSchema.safeParse(input);
  if (!parsed.success) {
    const fields = diagnosticFields(input);
    return {
      ok: false,
      fallback: createValidationFallback({
        ...fields,
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      }),
    };
  }
  const key = `${parsed.data.component_type}@${parsed.data.schema_version}` as ServerGenerativeUiRegistryKey;
  const entry = serverGenerativeUiRegistry[key];
  if (!entry) {
    return {
      ok: false,
      fallback: createValidationFallback({
        componentType: parsed.data.component_type,
        schemaVersion: parsed.data.schema_version,
        text: parsed.data.fallback_text,
        sources: parsed.data.provenance.sources,
        issues: ["The component type or schema version is not registered."],
      }),
    };
  }
  const transformed = entry.transform(parsed.data.props);
  return { ok: true, part: { ...parsed.data, props: transformed } as GenerativeUiPart };
}
