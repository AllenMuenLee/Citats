"use client";

import { useId, useMemo, useState } from "react";
import type { FlightComparisonProps, FlightItinerary } from "@ai-browser/contracts";
import styles from "./flight-comparison.module.css";

export type FlightDetailCommand = { command_type: "flight.detail"; component_instance_id: string; arguments: { itinerary_id: string } };
export type FlightComparisonViewProps = FlightComparisonProps & { loading?: boolean; error?: string; onCommand?: (command: FlightDetailCommand) => void };
type SortKey = "price" | "duration" | "stops" | "departure";
type DepartureWindow = "any" | "morning" | "afternoon" | "evening";

function durationLabel(minutes: number | null) { return minutes === null ? "Duration unavailable" : `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }
function timeLabel(timestamp: string) {
  const time = timestamp.match(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/)?.[1] ?? timestamp;
  const offset = timestamp.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1];
  return `${time} (${offset === "Z" ? "UTC" : `UTC${offset}`})`;
}
function fareLabel(item: FlightItinerary) { return item.fare ? `${item.fare.currency} ${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(item.fare.amount)}` : "Fare unavailable"; }
function departureBucket(timestamp: string): Exclude<DepartureWindow, "any"> { const hour = Number(timestamp.slice(11, 13)); return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"; }
function nullable(left: number | null, right: number | null) { return left === null ? (right === null ? 0 : 1) : right === null ? -1 : left - right; }
function sorted(items: FlightItinerary[], sort: SortKey) {
  return [...items].sort((left, right) => {
    let result = 0;
    if (sort === "price") result = left.fare?.currency === right.fare?.currency ? nullable(left.fare?.amount ?? null, right.fare?.amount ?? null) : (left.fare?.currency ?? "ZZZ").localeCompare(right.fare?.currency ?? "ZZZ");
    else if (sort === "duration") result = nullable(left.total_duration_minutes, right.total_duration_minutes);
    else if (sort === "stops") result = nullable(left.stop_count, right.stop_count);
    else result = left.legs[0]!.departure_at.localeCompare(right.legs[0]!.departure_at);
    return result || left.itinerary_id.localeCompare(right.itinerary_id);
  });
}

export function FlightComparison(props: FlightComparisonViewProps) {
  const [sort, setSort] = useState<SortKey>("price");
  const [window, setWindow] = useState<DepartureWindow>("any");
  const [selected, setSelected] = useState<string[]>([]);
  const id = useId();
  const visible = useMemo(() => sorted(props.itineraries.filter((item) => window === "any" || departureBucket(item.legs[0]!.departure_at) === window), sort), [props.itineraries, sort, window]);
  if (props.loading) return <section className={styles.panel} aria-busy="true"><p role="status">Loading flight comparisons...</p></section>;
  if (props.error) return <section className={styles.panel}><p role="alert">Flight comparison failed: {props.error}</p></section>;
  const stale = props.warnings.some((warning) => warning.code === "stale_data");
  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <header className={styles.header}><div><p className={styles.secondary}>Generated flight comparison</p><h2 id={`${id}-title`}>{props.query.origin} to {props.query.destination}</h2></div><p className={styles.secondary}>{stale ? "Stale results - " : ""}Retrieved <time dateTime={props.freshness.retrieved_at}>{props.freshness.retrieved_at}</time></p></header>
    <p className={styles.notice} role="note"><strong>Verify availability.</strong> {props.availability_disclaimer}</p>
    {props.warnings.map((item) => <p className={styles.warning} role="status" key={`${item.code}-${item.message}`}>{item.message}</p>)}
    <div className={styles.controls}>
      <label>Sort by<select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}><option value="price">Price</option><option value="duration">Duration</option><option value="stops">Stops</option><option value="departure">Departure</option></select></label>
      <label>Departure<select value={window} onChange={(event) => setWindow(event.target.value as DepartureWindow)}><option value="any">Any time</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option><option value="evening">Evening</option></select></label>
    </div>
    <p id={`${id}-status`} className={styles.srOnly} aria-live="polite">Showing {visible.length} flight options sorted by {sort}.</p>
    {visible.length === 0 ? <p className={styles.empty}>No flight options match this departure window.</p> : <ul className={styles.list} aria-describedby={`${id}-status`}>{visible.map((item) => {
      const first = item.legs[0]!; const last = item.legs.at(-1)!; const stops = item.legs.slice(0, -1).map((leg) => leg.destination); const chosen = selected.includes(item.itinerary_id);
      return <li className={styles.card} key={item.itinerary_id}>
        <div className={styles.summary}><div><strong>{timeLabel(first.departure_at)}</strong><span>{first.origin} · {first.departure_at.slice(0, 10)}</span></div><div><strong>{durationLabel(item.total_duration_minutes)}</strong><span>{item.stop_count === 0 ? "Nonstop" : `${item.stop_count ?? "Unknown"} stops${stops.length ? ` via ${stops.join(", ")}` : ""}`}</span></div><div><strong>{timeLabel(last.arrival_at)}</strong><span>{last.destination} · {last.arrival_at.slice(0, 10)}</span></div><div><strong>{fareLabel(item)}</strong><span>{item.fare?.qualifier ?? "Price qualifier unavailable"}</span></div></div>
        <p className={styles.secondary}>{item.carriers.join(", ")}</p>
        {item.baggage_caveat && <p>Baggage: {item.baggage_caveat}</p>}{item.refund_caveat && <p>Refunds: {item.refund_caveat}</p>}
        {item.warnings.map((warning) => <p className={styles.warning} key={warning.message}>{warning.message}</p>)}
        <div className={styles.actions}><button type="button" aria-pressed={chosen} onClick={() => setSelected((current) => chosen ? current.filter((value) => value !== item.itinerary_id) : [...current, item.itinerary_id])}>{chosen ? "Remove from comparison" : "Compare"}</button>{props.onCommand && <button type="button" onClick={() => props.onCommand?.({ command_type: "flight.detail", component_instance_id: props.component_instance_id, arguments: { itinerary_id: item.itinerary_id } })}>Request details</button>}</div>
        <details><summary>Leg details</summary><ol className={styles.legs}>{item.legs.map((leg) => <li key={leg.leg_id}><strong>{leg.origin} to {leg.destination}</strong><span>{timeLabel(leg.departure_at)} to {timeLabel(leg.arrival_at)}</span><span>{leg.carrier}{leg.flight_number ? ` ${leg.flight_number}` : ""} · {durationLabel(leg.duration_minutes)}</span></li>)}</ol></details>
        <p className={styles.secondary}>Sources: {item.source_ids.map((sourceId, index) => { const source = props.sources.find((value) => value.source_id === sourceId)!; return <span key={sourceId}>{index ? ", " : ""}<a className={styles.link} href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a></span>; })}</p>
      </li>;
    })}</ul>}
    {selected.length > 0 && <p role="status">{selected.length} option{selected.length === 1 ? "" : "s"} selected for comparison.</p>}
  </section>;
}
