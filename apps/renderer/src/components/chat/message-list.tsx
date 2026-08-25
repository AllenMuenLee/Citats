"use client";

import { useMemo } from "react";
import Image from "next/image";
import type { ImageLoaderProps } from "next/image";
import { buildSourceIndex, SourceList } from "../citations";
import type { ChatPart } from "./chat-types";
import { renderMarkdown } from "./markdown";
import styles from "./chat.module.css";
import { GeneratedUiSurface } from "../generative-ui";

const passthroughImageLoader = ({ src }: ImageLoaderProps) => src;

export function MessageList({ parts }: { parts: ChatPart[] }) {
  const sourceIndex = useMemo(() => buildSourceIndex(parts), [parts]);

  if (!parts.length) {
    return <div className={styles.emptyState}><h2>What can I help you explore?</h2><p>Start a conversation. Your session stays in this window.</p></div>;
  }
  return <ol className={styles.messages} aria-label="Conversation">{parts.map((part) => <li key={part.id} className={`${styles.message} ${styles[part.type] ?? ""}`}>
    {part.type === "user" && <><span className={styles.partLabel}>You</span><p>{part.text}</p></>}
    {part.type === "assistant" && <><span className={styles.partLabel}>Assistant</span>{part.text ? <div className={styles.markdown}>{renderMarkdown(part.text, part.citations, sourceIndex)}</div> : <p>Thinking...</p>}</>}
    {part.type === "tool-status" && <p><span aria-hidden="true">{part.state === "completed" ? "Done:" : part.state === "failed" ? "Failed:" : "Working:"}</span> {part.label}</p>}
    {part.type === "artifact" && <figure className={styles.artifact}>
      {part.artifactType === "image" && part.url ? <Image loader={passthroughImageLoader} unoptimized src={part.url} alt={part.title} width={1024} height={1024} /> : null}
      {part.url ? <a href={part.url} target="_blank" rel="noreferrer">{part.title}</a> : <figcaption>{part.title}</figcaption>}
    </figure>}
    {part.type === "generated-ui" && <GeneratedUiSurface
      instanceId={part.instanceId} artifactId={part.artifactId} inputDigest={part.inputDigest}
      observationDigest={part.observationDigest} revision={part.revision} expiresAt={part.expiresAt}
      sourceCount={part.sourceCount} coverageLabel={part.coverageLabel}
      fallback={<p>{part.fallbackText}</p>}
      onCommand={async (command) => {
        const response = await fetch("/api/generative-ui/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instanceId: part.instanceId, revision: part.revision, ...command }) });
        if (!response.ok) throw new Error("Generated UI command was rejected");
      }}
    />}
    {part.type === "citation-sources" && <SourceList sources={part.sources} />}
    {part.type === "error" && <><strong>Response failed</strong><p>{part.message}</p></>}
  </li>)}</ol>;
}
