import {
  createElement,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

export type OpaqueId = string & { readonly __opaqueGeneratedUiId: unique symbol };
export type CommandKind = "activate" | "select" | "set_value" | "open_detail" | "media_control";
export type CommandArgument = string | number | boolean | null;
export type CommandArguments = Readonly<Record<string, CommandArgument>>;
export interface UiCommand {
  readonly kind: CommandKind;
  readonly capabilityId: OpaqueId;
  readonly revision: number;
  readonly arguments: CommandArguments;
}

export interface DisplayRecord { readonly id: OpaqueId; readonly fields: Readonly<Record<string, string | number | boolean | null>> }
export interface DisplaySource { readonly id: OpaqueId; readonly label: string; readonly provider: string }
export interface DisplayMedia { readonly id: OpaqueId; readonly kind: "image" | "audio" | "video" | "chart"; readonly altText: string; readonly safeReference: string }
export interface DisplayCapability { readonly id: OpaqueId; readonly allowedCommandKinds: readonly CommandKind[] }

export interface GeneratedViewProps {
  readonly instanceRevision: number;
  readonly records: readonly DisplayRecord[];
  readonly sources: readonly DisplaySource[];
  readonly media: readonly DisplayMedia[];
  readonly capabilities: readonly DisplayCapability[];
  readonly getRecord: (id: OpaqueId) => DisplayRecord | undefined;
  readonly getSource: (id: OpaqueId) => DisplaySource | undefined;
  readonly getMedia: (id: OpaqueId) => DisplayMedia | undefined;
  readonly getCapability: (id: OpaqueId) => DisplayCapability | undefined;
  readonly dispatchCommand: (command: UiCommand) => void;
}

export const semanticTokens = Object.freeze({
  canvas: "var(--color-bg-canvas)", surface: "var(--color-bg-surface)", elevated: "var(--color-bg-elevated)",
  textPrimary: "var(--color-text-primary)", textSecondary: "var(--color-text-secondary)", border: "var(--color-border)",
  accent: "var(--color-accent)", accentHover: "var(--color-accent-hover)", success: "var(--color-success)",
  warning: "var(--color-warning)", danger: "var(--color-danger)", focus: "var(--color-focus)",
  space4: "var(--space-4)", space8: "var(--space-8)", space12: "var(--space-12)", space16: "var(--space-16)",
  space24: "var(--space-24)", space32: "var(--space-32)", radiusControl: "var(--radius-control)",
  radiusPanel: "var(--radius-panel)", radiusOverlay: "var(--radius-overlay)",
} as const);

type BoxProps = ComponentPropsWithoutRef<"div"> & { readonly children?: ReactNode };
const base: CSSProperties = { color: semanticTokens.textPrimary };
export function Stack({ style, ...props }: BoxProps) { return <div {...props} style={{ ...base, display: "flex", flexDirection: "column", gap: semanticTokens.space12, ...style }} />; }
export function Inline({ style, ...props }: BoxProps) { return <div {...props} style={{ ...base, display: "flex", flexWrap: "wrap", alignItems: "center", gap: semanticTokens.space8, ...style }} />; }
export function Grid({ style, ...props }: BoxProps) { return <div {...props} style={{ ...base, display: "grid", gap: semanticTokens.space12, gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", ...style }} />; }
export function Card({ style, ...props }: BoxProps) { return <section {...props} style={{ ...base, background: semanticTokens.surface, border: `1px solid ${semanticTokens.border}`, borderRadius: semanticTokens.radiusPanel, padding: semanticTokens.space16, ...style }} />; }
export function Text(props: ComponentPropsWithoutRef<"p">) { return <p {...props} />; }
export function Heading(props: ComponentPropsWithoutRef<"h2">) { return <h2 {...props} />; }
export function Badge({ style, ...props }: ComponentPropsWithoutRef<"span">) { return <span {...props} style={{ border: `1px solid ${semanticTokens.border}`, borderRadius: semanticTokens.radiusControl, padding: `${semanticTokens.space4} ${semanticTokens.space8}`, ...style }} />; }
export const List = (props: ComponentPropsWithoutRef<"ul">) => <ul {...props} />;
export const ListItem = (props: ComponentPropsWithoutRef<"li">) => <li {...props} />;
export const Table = (props: ComponentPropsWithoutRef<"table">) => <table {...props} />;
export const TableHead = (props: ComponentPropsWithoutRef<"thead">) => <thead {...props} />;
export const TableBody = (props: ComponentPropsWithoutRef<"tbody">) => <tbody {...props} />;
export const TableRow = (props: ComponentPropsWithoutRef<"tr">) => <tr {...props} />;
export const TableHeader = (props: ComponentPropsWithoutRef<"th">) => <th {...props} />;
export const TableCell = (props: ComponentPropsWithoutRef<"td">) => <td {...props} />;
export const Label = (props: ComponentPropsWithoutRef<"label">) => <label {...props} />;
export const Select = (props: ComponentPropsWithoutRef<"select">) => <select {...props} />;
export const Option = (props: ComponentPropsWithoutRef<"option">) => <option {...props} />;
export const Status = (props: ComponentPropsWithoutRef<"div">) => <div role="status" aria-live="polite" {...props} />;
export const Warning = (props: ComponentPropsWithoutRef<"div">) => <div role="status" {...props} />;
export const Source = ({ source }: { readonly source: DisplaySource }) => <span>{source.provider}: {source.label}</span>;
export const Freshness = ({ label }: { readonly label: string }) => <span>{label}</span>;
export const Icon = ({ name, label }: { readonly name: "search" | "filter" | "sort" | "info" | "warning" | "close"; readonly label: string }) => <span role="img" aria-label={label} data-icon={name} />;
export const Media = ({ media }: { readonly media: DisplayMedia }) => media.kind === "image" ? <img src={media.safeReference} alt={media.altText} /> : <div role="img" aria-label={media.altText}>{media.altText}</div>;
export function Modal({ open, title, onClose, children }: { readonly open: boolean; readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) { return open ? <div role="dialog" aria-modal="true" aria-label={title}><button type="button" onClick={onClose}>Close</button>{children}</div> : null; }

export function CommandButton({ capabilityId, kind, arguments: args = {}, runtime, children, disabled }: { readonly capabilityId: OpaqueId; readonly kind: CommandKind; readonly arguments?: CommandArguments; readonly runtime: GeneratedViewProps; readonly children: ReactNode; readonly disabled?: boolean }) {
  const capability = runtime.getCapability(capabilityId);
  const permitted = capability?.allowedCommandKinds.includes(kind) === true;
  return <button type="button" disabled={disabled || !permitted} onClick={() => permitted && runtime.dispatchCommand(Object.freeze({ kind, capabilityId, revision: runtime.instanceRevision, arguments: Object.freeze({ ...args }) }))}>{children}</button>;
}

export function useBoundedState<T>(initial: T, allowed: readonly T[]): readonly [T, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const setBounded = useCallback((next: T) => { if (allowed.includes(next)) setValue(next); }, [allowed]);
  return useMemo(() => [value, setBounded] as const, [value, setBounded]);
}
export function formatNumber(value: number, locale = "en-US") { return new Intl.NumberFormat(locale).format(value); }
export function formatCurrency(value: number, currency: string, locale = "en-US") { return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value); }
export function formatDate(value: string, locale = "en-US") { return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value)); }
export { createElement };
