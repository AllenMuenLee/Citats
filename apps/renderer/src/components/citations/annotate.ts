import type { ChatPart, CitationMarker, CitationSource } from "../chat/chat-types";

export type AnnotatedSegment =
  | { kind: "text"; key: string; value: string }
  | { kind: "marker"; key: string; marker: CitationMarker; index: number };

/**
 * Splits `text` into plain-text segments interleaved with citation-marker
 * segments at their recorded positions, assigning each distinct
 * `citationId` a stable 1-based display index in first-appearance order
 * (so the same source cited twice in one message shows the same number
 * both times). Out-of-range marker positions are clamped rather than
 * dropped or thrown on, so a stray marker never breaks rendering.
 */
export function annotateWithCitations(text: string, markers: readonly CitationMarker[] = []): AnnotatedSegment[] {
  if (markers.length === 0) {
    return text.length > 0 ? [{ kind: "text", key: "text-0", value: text }] : [];
  }

  const sorted = [...markers].sort((a, b) => a.position - b.position);
  const indexByCitationId = new Map<string, number>();
  let nextIndex = 1;
  const segments: AnnotatedSegment[] = [];
  let cursor = 0;

  for (const marker of sorted) {
    const position = Math.max(0, Math.min(marker.position, text.length));
    if (position > cursor) {
      segments.push({ kind: "text", key: `text-${cursor}`, value: text.slice(cursor, position) });
      cursor = position;
    }
    let index = indexByCitationId.get(marker.citationId);
    if (index === undefined) {
      index = nextIndex++;
      indexByCitationId.set(marker.citationId, index);
    }
    segments.push({ kind: "marker", key: `marker-${marker.id}`, marker, index });
  }

  if (cursor < text.length) {
    segments.push({ kind: "text", key: `text-${cursor}`, value: text.slice(cursor) });
  }

  return segments;
}

/**
 * Builds a lookup of every `CitationSource` seen so far in the
 * conversation (from every `citation-sources` part across `parts`), keyed
 * by source id. Source ids are stable per conversation, so this is safe to
 * recompute from the full part list on every render.
 */
export function buildSourceIndex(parts: readonly ChatPart[]): Map<string, CitationSource> {
  const index = new Map<string, CitationSource>();
  for (const part of parts) {
    if (part.type !== "citation-sources") continue;
    for (const source of part.sources) {
      if (!index.has(source.id)) index.set(source.id, source);
    }
  }
  return index;
}
