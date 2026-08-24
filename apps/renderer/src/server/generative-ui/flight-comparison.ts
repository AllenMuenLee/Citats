import { flightComparisonPropsSchema, type FlightComparisonProps, type FlightItinerary } from "@ai-browser/contracts";

function warning(message: string) { return { code: "inconsistent_data" as const, message }; }
function elapsedMinutes(start: string, end: string): number | null {
  const value = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeItinerary(itinerary: FlightItinerary): FlightItinerary {
  const warnings = [...itinerary.warnings];
  let chronological = true;
  let calculatedDuration = 0;
  itinerary.legs.forEach((leg, index) => {
    const legDuration = elapsedMinutes(leg.departure_at, leg.arrival_at);
    if (legDuration === null) {
      chronological = false;
      warnings.push(warning(`Leg ${leg.leg_id} has an arrival that is not after departure.`));
    } else {
      calculatedDuration += legDuration;
      if (leg.duration_minutes !== null && Math.abs(leg.duration_minutes - legDuration) > 5) warnings.push(warning(`Leg ${leg.leg_id} duration differs from its timestamps.`));
    }
    const next = itinerary.legs[index + 1];
    if (next && (leg.destination !== next.origin || Date.parse(next.departure_at) < Date.parse(leg.arrival_at))) {
      chronological = false;
      warnings.push(warning(`Leg ${leg.leg_id} does not connect consistently to ${next.leg_id}.`));
    }
  });
  const journeyDuration = chronological ? elapsedMinutes(itinerary.legs[0]!.departure_at, itinerary.legs.at(-1)!.arrival_at) : null;
  if (itinerary.total_duration_minutes !== null && journeyDuration !== null && Math.abs(itinerary.total_duration_minutes - journeyDuration) > 5) warnings.push(warning("The supplied total duration differs from the itinerary timestamps."));
  const calculatedStops = itinerary.legs.length - 1;
  if (itinerary.stop_count !== null && itinerary.stop_count !== calculatedStops) warnings.push(warning("The supplied stop count differs from the itinerary legs."));
  return { ...itinerary, total_duration_minutes: itinerary.total_duration_minutes ?? journeyDuration ?? (calculatedDuration || null), stop_count: itinerary.stop_count ?? calculatedStops, warnings: warnings.slice(0, 10) };
}

export function transformFlightComparison(input: unknown): FlightComparisonProps {
  const parsed = flightComparisonPropsSchema.parse(input);
  const warnings = [...parsed.warnings];
  if (parsed.freshness.stale_after && Date.parse(parsed.freshness.stale_after) <= Date.now() && !warnings.some((item) => item.code === "stale_data")) {
    warnings.push({ code: "stale_data", message: "These flight results may be out of date." });
  }
  return { ...parsed, itineraries: parsed.itineraries.map(normalizeItinerary), warnings };
}

export function formatFlightComparisonFallback(props: FlightComparisonProps): string {
  if (props.itineraries.length === 0) return `No flights found from ${props.query.origin} to ${props.query.destination}. ${props.availability_disclaimer}`;
  const rows = props.itineraries.map((itinerary) => {
    const route = itinerary.legs.map((leg) => leg.origin).concat(itinerary.legs.at(-1)!.destination).join(" -> ");
    const fare = itinerary.fare ? `${itinerary.fare.currency} ${itinerary.fare.amount}` : "fare unavailable";
    return `${route}: ${fare}, ${itinerary.stop_count ?? "unknown"} stop(s), ${itinerary.total_duration_minutes ?? "unknown"} minutes`;
  });
  return [`Flights from ${props.query.origin} to ${props.query.destination}:`, ...rows, props.availability_disclaimer].join("\n");
}
