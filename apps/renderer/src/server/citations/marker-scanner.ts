import "server-only";

/**
 * Incremental scanner that strips `[[cite:<chunkId>]]` markers out of a
 * stream of raw model text, extracting each marker's `chunkId` and its
 * position (character offset into the *clean*, marker-stripped output)
 * as soon as it can be sure it has seen a complete marker -- even when a
 * marker's characters arrive split across multiple `push()` calls (the
 * model is streamed token-by-token, so `"[[cite:ch"` and `"unk-0]]"` can
 * easily land in separate deltas).
 *
 * This is what lets the chat stream keep emitting real-time `text-delta`
 * events (never buffering the whole response) while the raw
 * `[[cite:...]]` syntax itself never reaches the client -- only the
 * resolved `citation-marker`/`citation-sources` events do (see
 * `orchestrator.ts`). System/tool instructions (see
 * `server/conversation/instructions.ts`) tell the model to emit this
 * exact marker syntax immediately after a claim sourced from
 * `browser.navigate_and_extract`, referencing one of that tool's
 * returned `chunkId`s.
 *
 * `chunkId` here is exactly whatever the model wrote between `cite:` and
 * `]]` -- this scanner does not know or care whether that id is real;
 * `orchestrator.ts` looks it up against the turn's actual evidence and
 * silently drops the marker if it doesn't resolve (an unknown/hallucinated
 * chunk id is never surfaced as a citation).
 */

const MARKER_PATTERN = /\[\[cite:([a-zA-Z0-9_-]{1,64})\]\]/g;
const MARKER_PREFIX = "[[cite:";
const MAX_CHUNK_ID_LENGTH = 64;

export interface CitationMarkerOccurrence {
  chunkId: string;
  /** Character offset into the scanner's cumulative *clean* output where this marker was found. */
  position: number;
}

export interface MarkerScanResult {
  /** Text safe to emit now -- never contains any part of a marker, complete or partial. */
  clean: string;
  markers: CitationMarkerOccurrence[];
}

/** True if `tail` (starting at `buffer[index]`) is a prefix of some valid, still-growing `[[cite:...]]` marker. */
function isPossibleMarkerPrefix(tail: string): boolean {
  const prefixOverlap = Math.min(tail.length, MARKER_PREFIX.length);
  if (tail.slice(0, prefixOverlap) !== MARKER_PREFIX.slice(0, prefixOverlap)) return false;
  if (tail.length <= MARKER_PREFIX.length) return true;
  const rest = tail.slice(MARKER_PREFIX.length);
  // Once past the literal "[[cite:" prefix: bounded id characters,
  // optionally followed by up to two of the closing "]]" (a *complete*
  // marker would already have been consumed by MARKER_PATTERN above, so
  // reaching here with two closing brackets already present cannot
  // actually happen for valid input -- this bound only exists so a
  // never-closing "[[cite:" followed by run-on id-shaped text cannot grow
  // the held-back tail without bound).
  return new RegExp(`^[a-zA-Z0-9_-]{0,${MAX_CHUNK_ID_LENGTH}}\\]{0,2}$`).test(rest);
}

/**
 * Leftmost index in `buffer` that could still grow into a valid marker,
 * or -1 if none. Searches for a single `[` (not `[[`) so a marker whose
 * opening `[[` itself splits across two pushes -- one delta ending in a
 * lone trailing `[`, the next starting with `[cite:...` -- is still held
 * back correctly instead of the first `[` being flushed prematurely.
 */
function findPendingMarkerStart(buffer: string): number {
  let searchFrom = 0;
  for (;;) {
    const index = buffer.indexOf("[", searchFrom);
    if (index === -1) return -1;
    if (isPossibleMarkerPrefix(buffer.slice(index))) return index;
    searchFrom = index + 1;
  }
}

export class CitationMarkerScanner {
  #buffer = "";
  #cleanLength = 0;

  /** Feed the next chunk of raw model text; returns clean text safe to emit now plus any markers found. */
  push(rawChunk: string): MarkerScanResult {
    this.#buffer += rawChunk;
    return this.#drain(false);
  }

  /** Call once the model's turn is fully done: flushes any held-back tail as literal text (never as a marker). */
  flush(): MarkerScanResult {
    return this.#drain(true);
  }

  #drain(isFinal: boolean): MarkerScanResult {
    const markers: CitationMarkerOccurrence[] = [];
    let clean = "";

    for (;;) {
      MARKER_PATTERN.lastIndex = 0;
      const match = MARKER_PATTERN.exec(this.#buffer);
      if (!match) break;
      const before = this.#buffer.slice(0, match.index);
      clean += before;
      this.#cleanLength += before.length;
      markers.push({ chunkId: match[1] ?? "", position: this.#cleanLength });
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
    }

    if (isFinal) {
      clean += this.#buffer;
      this.#cleanLength += this.#buffer.length;
      this.#buffer = "";
    } else {
      const pendingStart = findPendingMarkerStart(this.#buffer);
      const cutoff = pendingStart === -1 ? this.#buffer.length : pendingStart;
      const toFlush = this.#buffer.slice(0, cutoff);
      clean += toFlush;
      this.#cleanLength += toFlush.length;
      this.#buffer = this.#buffer.slice(cutoff);
    }

    return { clean, markers };
  }
}
