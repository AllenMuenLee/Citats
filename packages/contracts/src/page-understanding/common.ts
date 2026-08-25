import { z } from "zod";

/**
 * Shared leaf shapes for the Phase 3 page-understanding graph (P03-F02).
 * An opaque handle is minted server-side per observation (see
 * `services/browser/src/browser_service/page_observation/handles.py`) and
 * never carries a selector, DOM path, or script -- it is only ever a
 * lookup key back into that observation's own server-held graph.
 */

export const OPAQUE_HANDLE_MAX_LENGTH = 128;

export const OpaqueHandleSchema = z
  .string()
  .min(1)
  .max(OPAQUE_HANDLE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._:-]+$/, "must be an opaque handle (letters, digits, '.', '_', ':', '-')");

export type OpaqueHandle = z.infer<typeof OpaqueHandleSchema>;

/** Viewport-relative bounding box in CSS pixels; absent when a node has no box (e.g. a purely structural relationship). */
export const BoundingBoxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

/** Coarse visibility classification -- never a full computed-style dump (P03-F02 step 6's "semantic/layout facts, not full computed-style dumps"). */
export const VisibilityStateSchema = z.enum([
  "visible",
  "occluded",
  "offscreen",
  "hidden",
  "collapsed",
]);

export type VisibilityState = z.infer<typeof VisibilityStateSchema>;

/** Bounded, closed accessibility/interaction state (P03-F02 step 4 "current state"; mission item 12). Every field is a tri-state (true/false/not applicable to this control). */
export const ControlStateSchema = z
  .object({
    expanded: z.boolean().nullable(),
    pressed: z.boolean().nullable(),
    checked: z.boolean().nullable(),
    selected: z.boolean().nullable(),
    current: z.boolean().nullable(),
    busy: z.boolean(),
    invalid: z.boolean(),
    required: z.boolean(),
    disabled: z.boolean(),
    readOnly: z.boolean(),
    focusable: z.boolean(),
  })
  .strict();

export type ControlState = z.infer<typeof ControlStateSchema>;

export const DEFAULT_CONTROL_STATE: ControlState = {
  expanded: null,
  pressed: null,
  checked: null,
  selected: null,
  current: null,
  busy: false,
  invalid: false,
  required: false,
  disabled: false,
  readOnly: false,
  focusable: false,
};

/** Whether -- and why -- an observation (or a bounded sub-part of one) did not run to full completion (mission: "must never be fabricated"). */
export const ObservationStatusSchema = z.enum(["complete", "timeout", "unstable", "partial"]);

export type ObservationStatus = z.infer<typeof ObservationStatusSchema>;
