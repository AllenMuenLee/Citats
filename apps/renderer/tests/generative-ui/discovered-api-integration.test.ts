import { describe, expect, it } from "vitest";
import { generativeUiFromDiscoveredApi } from "../../src/server/generative-ui/from-discovered-api";

const base = {
  contractVersion: 1,
  correlation: { requestId: "request-1", userId: "user-1", sessionId: "session-1" },
  toolCallId: "call-1",
  status: "success",
  sensitivity: { sensitive: false, confirmationRequired: false },
};

function payload(resultKind: "product_results" | "flight_comparison" | "generic_records", records: object[]) {
  return {
    ...base,
    payload: {
      siteId: "local-fixture",
      operationId: "1234567890abcdef12345678",
      mapVersion: "map-version-1",
      resultKind,
      records,
      sources: [{ sourceId: "source-1", title: "Fixture API", url: "http://localhost:8765/api/results" }],
      retrievedAt: "2026-08-24T10:00:00+08:00",
      staleAfter: "2026-08-24T10:05:00+08:00",
      warnings: [],
      redacted: false,
      truncated: false,
      untrusted: true,
    },
  };
}

const context = { query: "Compare fixture results", correlationId: "request-1", invocationId: "call-1" };

describe("discovered API to generative UI", () => {
  it("transforms a product API result into the registered product component", () => {
    const part = generativeUiFromDiscoveredApi(payload("product_results", [{
      id: "p1",
      name: "Fixture headphones",
      priceAmount: 99,
      currency: "USD",
      merchant: "Fixture shop",
      availability: "available",
      attributes: { color: "black" },
    }]), context);
    expect(part).toMatchObject({
      component_type: "product_results",
      props: { items: [{ id: "p1", name: "Fixture headphones", price: { amount: "99", currency: "USD" } }] },
      provenance: { invocation_id: "call-1" },
    });
  });

  it("groups flattened flight API legs into a comparison itinerary", () => {
    const part = generativeUiFromDiscoveredApi(payload("flight_comparison", [
      { itineraryId: "trip-1", legId: "leg-1", origin: "TPE", destination: "KIX", departureAt: "2026-10-01T08:00:00+08:00", arrivalAt: "2026-10-01T11:30:00+09:00", durationMinutes: 150, carrier: "Fixture Air", fareAmount: 220, currency: "USD" },
      { itineraryId: "trip-1", legId: "leg-2", origin: "KIX", destination: "NRT", departureAt: "2026-10-01T13:00:00+09:00", arrivalAt: "2026-10-01T14:15:00+09:00", durationMinutes: 75, carrier: "Fixture Air", fareAmount: 220, currency: "USD" },
    ]), context);
    expect(part).toMatchObject({
      component_type: "flight_comparison",
      props: { query: { origin: "TPE", destination: "NRT" }, itineraries: [{ itinerary_id: "trip-1", legs: [{ leg_id: "leg-1" }, { leg_id: "leg-2" }] }] },
    });
  });

  it("does not generate arbitrary components for generic or invalid output", () => {
    expect(generativeUiFromDiscoveredApi(payload("generic_records", [{ ok: true }]), context)).toBeNull();
    expect(generativeUiFromDiscoveredApi({ ...base, payload: { resultKind: "model_component" } }, context)).toBeNull();
  });
});
