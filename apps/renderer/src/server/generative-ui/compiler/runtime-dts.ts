/**
 * The exact ambient declaration of `@ai-browser/generated-ui-runtime` that a
 * generated view is type-checked against (P04-F03).
 *
 * This is the single source of truth for two consumers that must never
 * drift apart:
 *
 * - `compiler.ts` embeds it in the isolated type-check lib, so a generated
 *   view that calls a runtime export with the wrong shape fails to compile.
 * - `generative-ui/system-prompt.ts` shows it to `UI_MODEL` verbatim, so the
 *   model writes against the real signatures instead of guessing them.
 *
 * It is intentionally minimal: the presentational primitives are `any`
 * (their props are ordinary JSX), but the two hooks and the three
 * formatters carry their true signatures, because those are exactly the
 * calls a model gets wrong when it has only a list of names.
 */
export const GENERATED_UI_RUNTIME_DTS = `declare module "@ai-browser/generated-ui-runtime" {
  export type OpaqueId = string;
  export interface DisplaySource { readonly id: OpaqueId; readonly title: string; readonly origin: string; readonly finalUrl: string; readonly retrievedAt: string; readonly captureStatus: "complete" | "truncated" | "partial"; }
  export interface DisplayCoverage { readonly requestedSources: number; readonly capturedSources: number; readonly note: string | null; }
  export interface GeneratedViewProps {
    readonly instanceRevision: number; readonly goal: string;
    readonly sources: readonly DisplaySource[]; readonly coverage: DisplayCoverage;
    getSource(id: OpaqueId): DisplaySource | undefined;
  }
  export const semanticTokens: Readonly<Record<string, string>>;
  export const Stack: any, Inline: any, Grid: any, Card: any, Region: any, Text: any, Heading: any, Badge: any, List: any, ListItem: any, Table: any, TableHead: any, TableBody: any, TableRow: any, TableHeader: any, TableCell: any, Label: any, Select: any, Option: any, Status: any, Warning: any, Source: any, Freshness: any, Icon: any, Modal: any;
  export function useBoundedState<T>(initial: T, allowed: readonly T[]): readonly [T, (next: T) => void];
  export function useLocalCollection<T>(items: readonly T[], options: { readonly filter?: (item: T) => boolean; readonly compare?: (a: T, b: T) => number }): readonly T[];
  export function formatNumber(value: number, locale?: string): string;
  export function formatCurrency(value: number, currency: string, locale?: string): string;
  export function formatDate(value: string, locale?: string): string;
  export const createElement: any; export const Fragment: any;
}`;
