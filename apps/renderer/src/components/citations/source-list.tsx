"use client";

import type { CitationSource } from "../chat/chat-types";
import { ExternalCitationLink } from "./external-citation-link";
import { formatRetrievedAt } from "./format";
import { originOf } from "./url-safety";
import styles from "./citations.module.css";

/**
 * The deduplicated list of sources cited in a completed answer: title,
 * destination origin, and retrieval time for each, per
 * docs/desktop-architecture-and-ui-specification.md's citation
 * requirements. Explicitly labeled as retrieved/cited evidence -- distinct
 * from the assistant's own generated text above it.
 */
export function SourceList({ sources }: { sources: CitationSource[] }) {
  if (sources.length === 0) return null;
  return (
    <section className={styles.sourceList} aria-label="Cited sources">
      <h3 className={styles.sourceListHeading}>Sources</h3>
      <p className={styles.sourceListNote}>Retrieved evidence cited to support this answer, not generated text.</p>
      <ol className={styles.sourceListItems}>
        {sources.map((source, index) => (
          <li key={source.id} className={styles.sourceListItem}>
            <span className={styles.sourceIndex} aria-hidden="true">
              [{index + 1}]
            </span>
            <span className={styles.sourceTitle}>{source.title}</span>
            <span className={styles.sourceOrigin}>{originOf(source.url)}</span>
            <span className={styles.sourceTime}>Retrieved {formatRetrievedAt(source.retrievedAt)}</span>
            <ExternalCitationLink url={source.url}>Open source</ExternalCitationLink>
          </li>
        ))}
      </ol>
    </section>
  );
}
