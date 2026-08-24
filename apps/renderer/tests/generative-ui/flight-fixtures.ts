import type { FlightComparisonProps } from "@ai-browser/contracts";

const source = { source_id: "source-1", title: "Example Flights", url: "https://flights.example/results" };
const baseLeg = { leg_id: "leg-1", origin: "SFO", destination: "JFK", departure_at: "2026-11-01T01:30:00-07:00", arrival_at: "2026-11-01T09:45:00-05:00", duration_minutes: 315, carrier: "Example Air", flight_number: "EA100" };

export const flightFixture: FlightComparisonProps = {
  component_instance_id: "instance-1",
  query: { origin: "SFO", destination: "JFK" },
  itineraries: [
    { itinerary_id: "overnight-dst", legs: [baseLeg], total_duration_minutes: 315, stop_count: 0, carriers: ["Example Air"], fare: { amount: 499.5, currency: "USD", qualifier: "Round trip, taxes included" }, baggage_caveat: "Carry-on only", refund_caveat: "Nonrefundable", source_ids: ["source-1"], warnings: [] },
    { itinerary_id: "multi-leg", legs: [
      { ...baseLeg, leg_id: "leg-2", destination: "ORD", arrival_at: "2026-11-01T06:00:00-06:00", duration_minutes: 210 },
      { ...baseLeg, leg_id: "leg-3", origin: "ORD", departure_at: "2026-11-01T07:30:00-06:00", arrival_at: "2026-11-01T10:45:00-05:00", duration_minutes: 135, carrier: "Other Air", flight_number: "OA20" },
    ], total_duration_minutes: 435, stop_count: 1, carriers: ["Example Air", "Other Air"], fare: { amount: 440, currency: "CAD", qualifier: "Basic fare" }, source_ids: ["source-1"], warnings: [] },
    { itinerary_id: "missing-fare", legs: [{ ...baseLeg, leg_id: "leg-4", departure_at: "2026-11-01T19:00:00-08:00", arrival_at: "2026-11-02T03:30:00-05:00" }], total_duration_minutes: null, stop_count: null, carriers: ["Example Air"], fare: null, source_ids: ["source-1"], warnings: [{ code: "partial_data", message: "Fare was not supplied." }] },
  ],
  sources: [source],
  freshness: { retrieved_at: "2026-08-24T08:00:00Z", stale_after: "2026-08-24T08:05:00Z" },
  availability_disclaimer: "Fares and seats can change before booking on the provider site.",
  warnings: [{ code: "stale_data", message: "These results may no longer reflect current availability." }],
};

export const emptyFlightFixture: FlightComparisonProps = { ...flightFixture, itineraries: [], warnings: [] };
