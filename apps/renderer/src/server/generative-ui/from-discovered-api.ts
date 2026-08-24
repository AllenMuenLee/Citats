import {
  InvokeDiscoveredApiSuccessResultSchema,
  generativeUiPartSchema,
  type GenerativeUiPart,
  type UiSourceReference,
} from "@ai-browser/contracts";
import { formatFlightComparisonFallback, transformFlightComparison } from "./flight-comparison";
import { formatProductResultFallback, transformProductResult } from "./product-results";

type RecordValue = string | number | boolean | null | Array<string | number | boolean | null> | Record<string, string | number | boolean | null>;
type ApiRecord = Record<string, RecordValue>;

function text(record: ApiRecord, key: string, maximum = 200): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}

function number(record: ApiRecord, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

function sources(input: Array<{ sourceId: string; title: string; url: string }>): UiSourceReference[] {
  return input.map((source) => ({ source_id: source.sourceId, title: source.title, url: source.url }));
}

function productPart(
  payload: ReturnType<typeof InvokeDiscoveredApiSuccessResultSchema.parse>["payload"],
  query: string,
  correlationId: string,
  invocationId: string,
): GenerativeUiPart {
  const sourceList = sources(payload.sources);
  const defaultSourceId = sourceList[0]!.source_id;
  const props = transformProductResult({
    component_instance_id: "pending-instance",
    query: query.slice(0, 300),
    items: payload.records.map((record, index) => {
      const priceAmount = number(record, "priceAmount");
      const currency = text(record, "currency", 3)?.toUpperCase();
      const rawAttributes = record.attributes;
      const attributes = rawAttributes && !Array.isArray(rawAttributes) && typeof rawAttributes === "object"
        ? Object.entries(rawAttributes).slice(0, 12).map(([name, value]) => ({ name: name.slice(0, 80), value: String(value).slice(0, 160) }))
        : [];
      return {
        id: text(record, "id", 128) ?? `${payload.operationId}-${index}`,
        name: text(record, "name") ?? "Unnamed product",
        ...(priceAmount !== undefined && currency?.length === 3 ? { price: { amount: String(priceAmount), currency } } : {}),
        merchant: text(record, "merchant", 120) ?? payload.siteId,
        availability: text(record, "availability", 120) ?? "Availability unknown",
        ...(text(record, "imageUrl", 2048) ? { image_url: text(record, "imageUrl", 2048) } : {}),
        attributes,
        source_ids: [text(record, "sourceId", 128) ?? defaultSourceId],
        partial_data_warnings: priceAmount === undefined ? ["Price was not supplied."] : [],
      };
    }),
    sources: sourceList,
    freshness: { retrieved_at: payload.retrievedAt, ...(payload.staleAfter ? { stale_after: payload.staleAfter } : {}) },
    warnings: payload.warnings.map((message) => ({ code: "partial_data" as const, message })),
  });
  return generativeUiPartSchema.parse({
    component_type: "product_results",
    schema_version: "1.0",
    instance_id: "pending-instance",
    result_digest: "0".repeat(64),
    props,
    provenance: { invocation_id: invocationId, sources: sourceList },
    allowed_commands: [],
    correlation_id: correlationId,
    freshness: props.freshness,
    warnings: props.warnings,
    fallback_text: formatProductResultFallback(props),
  });
}

function flightPart(
  payload: ReturnType<typeof InvokeDiscoveredApiSuccessResultSchema.parse>["payload"],
  correlationId: string,
  invocationId: string,
): GenerativeUiPart {
  const sourceList = sources(payload.sources);
  const defaultSourceId = sourceList[0]!.source_id;
  const grouped = new Map<string, ApiRecord[]>();
  for (const record of payload.records) {
    const key = text(record, "itineraryId", 128) ?? text(record, "id", 128) ?? `itinerary-${grouped.size + 1}`;
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  const firstRecord = payload.records[0] ?? {};
  const lastRecord = payload.records.at(-1) ?? firstRecord;
  const origin = text(firstRecord, "origin", 3)?.toUpperCase() ?? "UNK";
  const destination = text(lastRecord, "destination", 3)?.toUpperCase() ?? "UNK";
  const props = transformFlightComparison({
    component_instance_id: "pending-instance",
    query: { origin, destination },
    itineraries: [...grouped].map(([itineraryId, records]) => {
      const fareAmount = number(records[0]!, "fareAmount");
      const currency = text(records[0]!, "currency", 3)?.toUpperCase();
      return {
        itinerary_id: itineraryId,
        legs: records.map((record, index) => ({
          leg_id: text(record, "legId", 128) ?? `${itineraryId}-leg-${index + 1}`,
          origin: text(record, "origin", 3)?.toUpperCase() ?? "UNK",
          destination: text(record, "destination", 3)?.toUpperCase() ?? "UNK",
          departure_at: text(record, "departureAt", 64) ?? payload.retrievedAt,
          arrival_at: text(record, "arrivalAt", 64) ?? payload.retrievedAt,
          duration_minutes: number(record, "durationMinutes") ?? null,
          carrier: text(record, "carrier", 100) ?? "Carrier unavailable",
          ...(text(record, "flightNumber", 20) ? { flight_number: text(record, "flightNumber", 20) } : {}),
        })),
        total_duration_minutes: number(records[0]!, "totalDurationMinutes") ?? null,
        stop_count: number(records[0]!, "stopCount") ?? null,
        carriers: [...new Set(records.map((record) => text(record, "carrier", 100) ?? "Carrier unavailable"))],
        fare: fareAmount !== undefined && currency?.length === 3 ? { amount: fareAmount, currency } : null,
        source_ids: [text(records[0]!, "sourceId", 128) ?? defaultSourceId],
        warnings: [],
      };
    }),
    sources: sourceList,
    freshness: { retrieved_at: payload.retrievedAt, ...(payload.staleAfter ? { stale_after: payload.staleAfter } : {}) },
    availability_disclaimer: "Verify availability with the cited provider before making plans.",
    warnings: payload.warnings.map((message) => ({ code: "partial_data" as const, message })),
  });
  return generativeUiPartSchema.parse({
    component_type: "flight_comparison",
    schema_version: "1.0",
    instance_id: "pending-instance",
    result_digest: "0".repeat(64),
    props,
    provenance: { invocation_id: invocationId, sources: sourceList },
    allowed_commands: [],
    correlation_id: correlationId,
    freshness: props.freshness,
    warnings: props.warnings,
    fallback_text: formatFlightComparisonFallback(props),
  });
}

export function generativeUiFromDiscoveredApi(
  input: unknown,
  context: { query: string; correlationId: string; invocationId: string },
): GenerativeUiPart | null {
  const result = InvokeDiscoveredApiSuccessResultSchema.safeParse(input);
  if (!result.success) return null;
  if (result.data.payload.resultKind === "product_results") {
    return productPart(result.data.payload, context.query, context.correlationId, context.invocationId);
  }
  if (result.data.payload.resultKind === "flight_comparison") {
    return flightPart(result.data.payload, context.correlationId, context.invocationId);
  }
  return null;
}
