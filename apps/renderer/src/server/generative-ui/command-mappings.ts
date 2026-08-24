import {
  flightDetailArgumentsSchema,
  flightFilterArgumentsSchema,
  flightRefreshArgumentsSchema,
  productFilterArgumentsSchema,
  productRefreshArgumentsSchema,
  type UiCommandType,
} from "../../../../../packages/contracts/src/ui/ui-command";
import type { UiInstanceRecord } from "./instance-store";

const FIXED_COMMANDS: NonNullable<UiInstanceRecord["commands"]> = Object.freeze({
  "product.refresh": { argumentSchema: productRefreshArgumentsSchema, tool: "products.search", relationship: "replace" },
  "product.filter": { argumentSchema: productFilterArgumentsSchema, tool: "products.search", relationship: "replace" },
  "flight.refresh": { argumentSchema: flightRefreshArgumentsSchema, tool: "flights.search", relationship: "replace" },
  "flight.filter": { argumentSchema: flightFilterArgumentsSchema, tool: "flights.search", relationship: "replace" },
  "flight.detail": { argumentSchema: flightDetailArgumentsSchema, tool: "flights.detail", relationship: "append" },
});

export function commandMappingsFor(types: readonly UiCommandType[]): UiInstanceRecord["commands"] {
  return Object.freeze(Object.fromEntries(types.map((type) => [type, FIXED_COMMANDS[type]])));
}
