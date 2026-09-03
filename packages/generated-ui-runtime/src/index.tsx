import {
  Fragment,
  createElement,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

/**
 * The frozen runtime a generated view is allowed to import from -- and the
 * only module it may name at all (P04-F03 step 1).
 *
 * Everything here is either a presentational primitive over data the host
 * already supplied, a bounded local-state hook, or a pure formatter. There
 * is deliberately no command channel, no dispatch, no host call, no fetch,
 * no storage, and no navigation: a generated view reads its props and
 * renders. Whatever it wants to do beyond that, it cannot.
 */

export type OpaqueId = string & { readonly __opaqueGeneratedUiId: unique symbol };

export interface DisplaySource {
  readonly id: OpaqueId;
  readonly title: string;
  readonly origin: string;
  readonly finalUrl: string;
  readonly retrievedAt: string;
  readonly captureStatus: "complete" | "truncated" | "partial";
}

export interface DisplayCoverage {
  readonly requestedSources: number;
  readonly capturedSources: number;
  readonly note: string | null;
}

/**
 * Everything the sandbox is handed. There is no plan-derived record, fact,
 * media, or collection data: the grounded content lives in the generated
 * source itself, written from the planner's implementation prompt. What the
 * host supplies is the trusted request label, the trusted source metadata
 * the view may attribute, and bounded coverage numbers.
 */
export interface GeneratedViewProps {
  readonly instanceRevision: number;
  readonly goal: string;
  readonly sources: readonly DisplaySource[];
  readonly coverage: DisplayCoverage;
  readonly getSource: (id: OpaqueId) => DisplaySource | undefined;
}

export const semanticTokens = Object.freeze({
  canvas: "var(--color-bg-canvas)",
  surface: "var(--color-bg-surface)",
  elevated: "var(--color-bg-elevated)",
  textPrimary: "var(--color-text-primary)",
  textSecondary: "var(--color-text-secondary)",
  border: "var(--color-border)",
  accent: "var(--color-accent)",
  accentHover: "var(--color-accent-hover)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
  focus: "var(--color-focus)",
  space4: "var(--space-4)",
  space8: "var(--space-8)",
  space12: "var(--space-12)",
  space16: "var(--space-16)",
  space24: "var(--space-24)",
  space32: "var(--space-32)",
  radiusControl: "var(--radius-control)",
  radiusPanel: "var(--radius-panel)",
  radiusOverlay: "var(--radius-overlay)",
} as const);

type BoxProps = ComponentPropsWithoutRef<"div"> & { readonly children?: ReactNode };
const base: CSSProperties = { color: semanticTokens.textPrimary };

export function Stack({ style, ...props }: BoxProps) {
  return <div {...props} style={{ ...base, display: "flex", flexDirection: "column", gap: semanticTokens.space12, ...style }} />;
}
export function Inline({ style, ...props }: BoxProps) {
  return <div {...props} style={{ ...base, display: "flex", flexWrap: "wrap", alignItems: "center", gap: semanticTokens.space8, ...style }} />;
}
export function Grid({ style, ...props }: BoxProps) {
  return <div {...props} style={{ ...base, display: "grid", gap: semanticTokens.space12, gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", ...style }} />;
}
export function Card({ style, ...props }: BoxProps) {
  return <section {...props} style={{ ...base, background: semanticTokens.surface, border: `1px solid ${semanticTokens.border}`, borderRadius: semanticTokens.radiusPanel, padding: semanticTokens.space16, ...style }} />;
}

/**
 * A landmark-capable region. `label` names it for assistive technology and
 * the static validator collects it as one of the manifest's responsive
 * regions.
 */
export function Region({ label, as = "section", style, children }: {
  readonly label: string;
  readonly as?: "section" | "header" | "footer" | "nav" | "main" | "article" | "div";
  readonly style?: CSSProperties;
  readonly children?: ReactNode;
}) {
  return createElement(as, { "aria-label": label, style: { ...base, ...style } }, children);
}

export function Text(props: ComponentPropsWithoutRef<"p">) { return <p {...props} />; }
export function Heading({ level = 2, ...props }: ComponentPropsWithoutRef<"h2"> & { readonly level?: 1 | 2 | 3 | 4 }) {
  return createElement(`h${level}`, props);
}
export function Badge({ style, ...props }: ComponentPropsWithoutRef<"span">) {
  return <span {...props} style={{ border: `1px solid ${semanticTokens.border}`, borderRadius: semanticTokens.radiusControl, padding: `${semanticTokens.space4} ${semanticTokens.space8}`, ...style }} />;
}
export const List = (props: ComponentPropsWithoutRef<"ul">) => <ul {...props} />;
export const ListItem = (props: ComponentPropsWithoutRef<"li">) => <li {...props} />;
export const Table = (props: ComponentPropsWithoutRef<"table">) => <table {...props} />;
export const TableHead = (props: ComponentPropsWithoutRef<"thead">) => <thead {...props} />;
export const TableBody = (props: ComponentPropsWithoutRef<"tbody">) => <tbody {...props} />;
export const TableRow = (props: ComponentPropsWithoutRef<"tr">) => <tr {...props} />;
export const TableHeader = (props: ComponentPropsWithoutRef<"th">) => <th scope="col" {...props} />;
export const TableCell = (props: ComponentPropsWithoutRef<"td">) => <td {...props} />;
export const Label = (props: ComponentPropsWithoutRef<"label">) => <label {...props} />;
export const Select = (props: ComponentPropsWithoutRef<"select">) => <select {...props} />;
export const Option = (props: ComponentPropsWithoutRef<"option">) => <option {...props} />;
export const Status = (props: ComponentPropsWithoutRef<"div">) => <div role="status" aria-live="polite" {...props} />;
export const Warning = (props: ComponentPropsWithoutRef<"div">) => <div role="status" {...props} />;

/** Provenance, rendered as text. The URL is identity, never a link the reader can follow. */
export const Source = ({ source }: { readonly source: DisplaySource }) => (
  <span>
    {source.title} — {source.origin}
    {source.captureStatus === "complete" ? "" : ` (${source.captureStatus} capture)`}
  </span>
);

export const Freshness = ({ label }: { readonly label: string }) => <span>{label}</span>;

export const Icon = ({ name, label }: {
  readonly name: "search" | "filter" | "sort" | "info" | "warning" | "close" | "expand";
  readonly label: string;
}) => <span role="img" aria-label={label} data-icon={name} />;

export function Modal({ open, title, onClose, children }: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return open ? (
    <div role="dialog" aria-modal="true" aria-label={title} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      <button type="button" onClick={onClose}>Close</button>
      {children}
    </div>
  ) : null;
}

/**
 * Component-local state, bounded to an allowlist of values. This is the
 * whole of what a generated view can "do": a React state change over data
 * it already holds.
 */
export function useBoundedState<T>(initial: T, allowed: readonly T[]): readonly [T, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const setBounded = useCallback((next: T) => { if (allowed.includes(next)) setValue(next); }, [allowed]);
  return useMemo(() => [value, setBounded] as const, [value, setBounded]);
}

/** Ordering and filtering over already-supplied records, as pure local derivation. */
export function useLocalCollection<T>(items: readonly T[], options: {
  readonly filter?: (item: T) => boolean;
  readonly compare?: (a: T, b: T) => number;
}): readonly T[] {
  const { filter, compare } = options;
  return useMemo(() => {
    const selected = filter ? items.filter(filter) : [...items];
    return compare ? selected.sort(compare) : selected;
  }, [items, filter, compare]);
}

export function formatNumber(value: number, locale = "en-US") { return new Intl.NumberFormat(locale).format(value); }
export function formatCurrency(value: number, currency: string, locale = "en-US") { return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value); }
export function formatDate(value: string, locale = "en-US") { return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value)); }

export { Fragment, createElement };
