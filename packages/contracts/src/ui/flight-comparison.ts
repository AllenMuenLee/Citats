import { z } from "zod";

import {
  uiFreshnessSchema,
  uiIdentifierSchema,
  uiIsoDateTimeSchema,
  uiSourceReferenceSchema,
  uiTextSchema,
  uiWarningSchema,
} from "./common";

const airportCodeSchema = z.string().regex(/^[A-Z]{3}$/);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);

export const flightLegSchema = z.object({
  leg_id: uiIdentifierSchema,
  origin: airportCodeSchema,
  destination: airportCodeSchema,
  departure_at: uiIsoDateTimeSchema,
  arrival_at: uiIsoDateTimeSchema,
  duration_minutes: z.number().int().positive().max(2_880).nullable(),
  carrier: z.string().min(1).max(100),
  flight_number: z.string().min(1).max(20).optional(),
}).strict();

export const flightFareSchema = z.object({
  amount: z.number().nonnegative().finite(),
  currency: currencySchema,
  qualifier: z.string().min(1).max(200).optional(),
}).strict();

export const flightItinerarySchema = z.object({
  itinerary_id: uiIdentifierSchema,
  legs: z.array(flightLegSchema).min(1).max(8),
  total_duration_minutes: z.number().int().positive().max(10_080).nullable(),
  stop_count: z.number().int().nonnegative().max(7).nullable(),
  carriers: z.array(z.string().min(1).max(100)).min(1).max(8),
  fare: flightFareSchema.nullable(),
  baggage_caveat: uiTextSchema.optional(),
  refund_caveat: uiTextSchema.optional(),
  source_ids: z.array(uiIdentifierSchema).min(1).max(10),
  warnings: z.array(uiWarningSchema).max(10).default([]),
}).strict();

export const flightComparisonPropsSchema = z.object({
  component_instance_id: uiIdentifierSchema,
  query: z.object({
    origin: airportCodeSchema,
    destination: airportCodeSchema,
  }).strict(),
  itineraries: z.array(flightItinerarySchema).max(40),
  sources: z.array(uiSourceReferenceSchema).min(1).max(30),
  freshness: uiFreshnessSchema,
  availability_disclaimer: z.string().min(1).max(300),
  warnings: z.array(uiWarningSchema).max(20).default([]),
}).strict().superRefine((value, context) => {
  const sourceIds = new Set(value.sources.map((source) => source.source_id));
  const itineraryIds = new Set<string>();
  for (const itinerary of value.itineraries) {
    if (itineraryIds.has(itinerary.itinerary_id)) {
      context.addIssue({ code: "custom", message: "Itinerary IDs must be unique", path: ["itineraries"] });
    }
    itineraryIds.add(itinerary.itinerary_id);
    const legIds = new Set<string>();
    for (const leg of itinerary.legs) {
      if (legIds.has(leg.leg_id)) {
        context.addIssue({ code: "custom", message: "Leg IDs must be unique within an itinerary", path: ["itineraries", itinerary.itinerary_id, "legs"] });
      }
      legIds.add(leg.leg_id);
    }
    for (const sourceId of itinerary.source_ids) {
      if (!sourceIds.has(sourceId)) {
        context.addIssue({ code: "custom", message: `Unknown source ID: ${sourceId}`, path: ["itineraries", itinerary.itinerary_id, "source_ids"] });
      }
    }
  }
});

export type FlightLeg = z.infer<typeof flightLegSchema>;
export type FlightFare = z.infer<typeof flightFareSchema>;
export type FlightItinerary = z.infer<typeof flightItinerarySchema>;
export type FlightComparisonProps = z.infer<typeof flightComparisonPropsSchema>;
