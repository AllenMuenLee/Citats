import { describe, expect, it } from "vitest";
import { flightComparisonPropsSchema } from "@ai-browser/contracts";
import { formatFlightComparisonFallback, transformFlightComparison } from "../../src/server/generative-ui/flight-comparison";
import { emptyFlightFixture, flightFixture } from "./flight-fixtures";

describe("flight comparison normalization", () => {
  it("preserves local offsets across DST and mixed currencies", () => {
    const result = transformFlightComparison(flightFixture);
    expect(result.itineraries[0]?.legs[0]?.departure_at).toBe("2026-11-01T01:30:00-07:00");
    expect(result.itineraries.map((item) => item.fare?.currency)).toEqual(["USD", "CAD", undefined]);
  });

  it("calculates missing duration/stops and flags inconsistent supplied data", () => {
    const input = structuredClone(flightFixture);
    input.itineraries[2]!.legs[0]!.duration_minutes = null;
    input.itineraries[0]!.stop_count = 2;
    const result = transformFlightComparison(input);
    expect(result.itineraries[2]!.total_duration_minutes).toBe(330);
    expect(result.itineraries[2]!.stop_count).toBe(0);
    expect(result.itineraries[0]!.warnings.some((warning) => warning.message.includes("stop count"))).toBe(true);
  });

  it("marks disconnected multi-leg ordering without rearranging legs", () => {
    const input = structuredClone(flightFixture);
    input.itineraries[1]!.legs[1]!.origin = "LAX";
    const result = transformFlightComparison(input);
    expect(result.itineraries[1]!.legs.map((leg) => leg.leg_id)).toEqual(["leg-2", "leg-3"]);
    expect(result.itineraries[1]!.warnings.some((warning) => warning.message.includes("connect consistently"))).toBe(true);
  });

  it("rejects unknown provenance and bounded payload violations", () => {
    const unknownSource = structuredClone(flightFixture);
    unknownSource.itineraries[0]!.source_ids = ["not-present"];
    expect(flightComparisonPropsSchema.safeParse(unknownSource).success).toBe(false);
    expect(flightComparisonPropsSchema.safeParse({ ...flightFixture, itineraries: Array(41).fill(flightFixture.itineraries[0]) }).success).toBe(false);
  });

  it("provides cited-safe text fallback for populated and empty results", () => {
    expect(formatFlightComparisonFallback(flightFixture)).toContain("USD 499.5");
    expect(formatFlightComparisonFallback(emptyFlightFixture)).toContain("No flights found");
  });
});
