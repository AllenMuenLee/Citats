import {
  generativeUiPartSchema,
  type GenerativeUiPart,
} from "@ai-browser/contracts";
import type { ComponentType } from "react";
import { FlightComparison } from "./flight-comparison";
import { ProductResults } from "./product-results";

export const clientGenerativeUiRegistry = {
  "product_results@1.0": {
    component_type: "product_results",
    schema_version: "1.0",
    component: ProductResults,
  },
  "flight_comparison@1.0": {
    component_type: "flight_comparison",
    schema_version: "1.0",
    component: FlightComparison,
  },
} as const;

export type ClientGenerativeUiRegistryKey = keyof typeof clientGenerativeUiRegistry;

export function resolveGenerativeUiComponent(input: unknown):
  | { ok: true; part: GenerativeUiPart; component: ComponentType<never> }
  | { ok: false; fallbackText: string; reason: "invalid_schema" | "unknown_component" } {
  const parsed = generativeUiPartSchema.safeParse(input);
  if (!parsed.success) {
    const fallbackText = input && typeof input === "object" && "fallback_text" in input && typeof input.fallback_text === "string"
      ? input.fallback_text
      : "This generated view is unavailable.";
    return { ok: false, fallbackText, reason: "invalid_schema" };
  }
  const key = `${parsed.data.component_type}@${parsed.data.schema_version}` as ClientGenerativeUiRegistryKey;
  const registered = clientGenerativeUiRegistry[key];
  if (!registered) return { ok: false, fallbackText: parsed.data.fallback_text, reason: "unknown_component" };
  return { ok: true, part: parsed.data, component: registered.component as ComponentType<never> };
}
