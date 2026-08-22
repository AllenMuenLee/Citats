/**
 * Semantic theme tokens for the AI-Native Browser desktop renderer.
 *
 * Source of truth: docs/desktop-architecture-and-ui-specification.md,
 * "Semantic color tokens" table, plus the spacing grid and radius values
 * from "Typography and geometry". `tokens.css` is the CSS artifact
 * consumers actually load (see package.json `exports`); this module is the
 * typed description of the same values, kept in sync by the smoke test in
 * `tests/tokens.test.ts` (it re-parses `tokens.css` and diffs it against
 * this list, so a future edit that silently drops or diverges a token
 * fails a test instead of shipping unnoticed).
 *
 * No component primitives are exported yet -- Phase 0 scope is tokens
 * only (see docs/features/p00-f01-monorepo-environment.md).
 */

export interface ColorToken {
  /** CSS custom property name, e.g. "--color-bg-canvas". */
  name: string;
  light: string;
  dark: string;
  purpose: string;
}

export const COLOR_TOKENS: readonly ColorToken[] = [
  {
    name: "--color-bg-canvas",
    light: "#F6F7F9",
    dark: "#0D1017",
    purpose: "Window background",
  },
  {
    name: "--color-bg-surface",
    light: "#FFFFFF",
    dark: "#151A23",
    purpose: "Main panels",
  },
  {
    name: "--color-bg-elevated",
    light: "#EEF1F5",
    dark: "#1D2430",
    purpose: "Cards and task surfaces",
  },
  {
    name: "--color-text-primary",
    light: "#172033",
    dark: "#F3F6FC",
    purpose: "Primary text",
  },
  {
    name: "--color-text-secondary",
    light: "#5C667A",
    dark: "#AAB4C5",
    purpose: "Metadata",
  },
  {
    name: "--color-border",
    light: "#D9DEE8",
    dark: "#303949",
    purpose: "Borders and separators",
  },
  {
    name: "--color-accent",
    light: "#5865F2",
    dark: "#8992FF",
    purpose: "Primary actions and active state",
  },
  {
    name: "--color-accent-hover",
    light: "#4652D9",
    dark: "#A2A9FF",
    purpose: "Hover state",
  },
  {
    name: "--color-success",
    light: "#16845B",
    dark: "#45C995",
    purpose: "Success",
  },
  {
    name: "--color-warning",
    light: "#A15C00",
    dark: "#F2B85B",
    purpose: "Warnings and confirmation risk",
  },
  {
    name: "--color-danger",
    light: "#C43D4B",
    dark: "#FF7A88",
    purpose: "Failure and destructive actions",
  },
  {
    name: "--color-focus",
    light: "#2563EB",
    dark: "#8BB5FF",
    purpose: "Keyboard focus ring",
  },
] as const;

/** 4px spacing grid, per "Typography and geometry". */
export const SPACING_TOKENS: Readonly<Record<string, number>> = {
  "--space-4": 4,
  "--space-8": 8,
  "--space-12": 12,
  "--space-16": 16,
  "--space-24": 24,
  "--space-32": 32,
};

/** Radius scale: 6px controls, 10px cards/panels, 14px overlays. */
export const RADIUS_TOKENS: Readonly<Record<string, number>> = {
  "--radius-control": 6,
  "--radius-panel": 10,
  "--radius-overlay": 14,
};
