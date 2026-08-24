"use client";

import { useId, useState } from "react";
import type { CitationSource } from "../chat/chat-types";
import { ExternalCitationLink } from "./external-citation-link";
import { formatRetrievedAt } from "./format";
import { originOf } from "./url-safety";
import styles from "./citations.module.css";

/**
 * Inline numbered citation reference. `source` is looked up by the caller
 * (see `annotateWithCitations`/`buildSourceIndex`) and may be `undefined`
 * while the answer is still streaming and the final source list has not
 * arrived yet -- the marker still renders (never blocks/crashes), just
 * with a "still loading" placeholder in its popover instead of source
 * details.
 */
export function CitationMarker({ index, source }: { index: number; source?: CitationSource }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <span className={styles.markerWrap}>
      <button
        type="button"
        className={styles.marker}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        [{index}]
        <span className={styles.srOnly}>
          {" "}
          Citation {index}
          {source ? `: ${source.title}` : ""}. {open ? "Hide" : "Show"} source details.
        </span>
      </button>
      {open ? (
        <span id={panelId} role="note" className={styles.markerPanel}>
          <span className={styles.markerPanelLabel}>Cited source</span>
          {source ? (
            <>
              <span className={styles.markerPanelTitle}>{source.title}</span>
              <span className={styles.markerPanelOrigin}>{originOf(source.url)}</span>
              <span className={styles.markerPanelTime}>Retrieved {formatRetrievedAt(source.retrievedAt)}</span>
              <ExternalCitationLink url={source.url}>Open source</ExternalCitationLink>
            </>
          ) : (
            <span className={styles.markerPanelPending}>Source details are still loading.</span>
          )}
        </span>
      ) : null}
    </span>
  );
}
