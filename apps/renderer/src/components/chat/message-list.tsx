"use client";

import { useMemo } from "react";
import Image from "next/image";
import type { ImageLoaderProps } from "next/image";
import { buildSourceIndex, SourceList } from "../citations";
import type { ChatPart } from "./chat-types";
import { renderMarkdown } from "./markdown";
import styles from "./chat.module.css";

const passthroughImageLoader = ({ src }: ImageLoaderProps) => src;

export function MessageList({ parts, openGeneratedUiId, onOpenGeneratedUi }: { parts: ChatPart[]; openGeneratedUiId: string | null; onOpenGeneratedUi: (instanceId: string) => void }) {
  const sourceIndex = useMemo(() => buildSourceIndex(parts), [parts]);

  if (!parts.length) {
    return <div className={styles.emptyState}><h2>What can I help you explore?</h2><p>Start a conversation. Your session stays in this window.</p></div>;
  }
  return <ol className={styles.messages} aria-label="Conversation">{parts.map((part) => <li key={part.id} className={`${styles.message} ${styles[part.type] ?? ""}`}>
    {part.type === "user" && <><span className={styles.partLabel}>You</span><p>{part.text}</p></>}
    {part.type === "assistant" && <><span className={styles.partLabel}>Assistant</span>{part.text ? <div className={styles.markdown}>{renderMarkdown(part.text, part.citations, sourceIndex)}</div> : <p>Thinking...</p>}</>}
    {part.type === "tool-status" && <div>
      <p><span aria-hidden="true">{part.state === "completed" ? "Done:" : part.state === "failed" ? "Failed:" : "Working:"}</span> {part.label}</p>
      {part.url && <dl className={styles.toolFailureDetails}><dt>URL</dt><dd><a href={part.url} target="_blank" rel="noreferrer">{part.url}</a></dd></dl>}
      {part.state === "failed" && (part.response || part.reason) && <dl className={styles.toolFailureDetails}>
        {part.response && <><dt>Response</dt><dd>{part.response}</dd></>}
        {part.reason && <><dt>Reason</dt><dd>{part.reason}</dd></>}
      </dl>}
    </div>}
    {part.type === "artifact" && <figure className={styles.artifact}>
      {part.artifactType === "image" && part.url ? <Image loader={passthroughImageLoader} unoptimized src={part.url} alt={part.title} width={1024} height={1024} /> : null}
      {part.url ? <a href={part.url} target="_blank" rel="noreferrer">{part.title}</a> : <figcaption>{part.title}</figcaption>}
    </figure>}
    {part.type === "generated-ui" && <div className={styles.generatedUiPrompt}>
      <span><span aria-hidden="true">Generated view ready:</span> {part.coverageLabel} · {part.sourceCount} {part.sourceCount === 1 ? "source" : "sources"}</span>
      <button type="button" className={styles.secondaryButton} aria-pressed={openGeneratedUiId === part.instanceId} onClick={() => onOpenGeneratedUi(part.instanceId)}>
        {openGeneratedUiId === part.instanceId ? "Showing generated view" : "Show generated view"}
      </button>
    </div>}
    {part.type === "citation-sources" && <SourceList sources={part.sources} />}
    {part.type === "error" && <><strong>Response failed</strong><p>{part.message}</p></>}
  </li>)}</ol>;
}
