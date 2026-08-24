"use client";

import { useEffect, useMemo } from "react";
import Image from "next/image";
import type { ImageLoaderProps } from "next/image";
import { buildSourceIndex, SourceList } from "../citations";
import type { ChatPart } from "./chat-types";
import { renderMarkdown } from "./markdown";
import { GeneratedUiView } from "../generative-ui/generated-ui-view";
import { resolveGenerativeUiComponent } from "../generative-ui/registry";
import { recordGenerativeUiMetric } from "../generative-ui/telemetry";
import styles from "./chat.module.css";

const passthroughImageLoader = ({ src }: ImageLoaderProps) => src;

function GeneratedPart({ payload, sessionId }: { payload: unknown; sessionId: string }) {
  const resolved = useMemo(() => resolveGenerativeUiComponent(payload), [payload]);
  useEffect(() => {
    if (resolved.ok) return;
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
    const componentType = record?.component_type === "flight_comparison" ? "flight_comparison" : "product_results";
    recordGenerativeUiMetric({ componentType, schemaVersion: "1.0", event: "render_fallback", fallbackReason: resolved.reason });
  }, [payload, resolved]);
  if (!resolved.ok) {
    return <section role="alert"><strong>Generated view unavailable</strong><p>{resolved.fallbackText}</p></section>;
  }
  return <GeneratedUiView part={resolved.part} sessionId={sessionId} />;
}

export function MessageList({ parts, sessionId = "desktop-session" }: { parts: ChatPart[]; sessionId?: string }) {
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
    {part.type === "citation-sources" && <SourceList sources={part.sources} />}
    {part.type === "generative-ui" && <GeneratedPart payload={part.payload} sessionId={sessionId} />}
    {part.type === "generative-ui-warning" && <section role="alert"><strong>Generated view unavailable</strong><p>{part.text}</p></section>}
    {part.type === "error" && <><strong>Response failed</strong><p>{part.message}</p></>}
  </li>)}</ol>;
}
