"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatPart, ChatStatus, ChatStreamEvent } from "../components/chat/chat-types";

export const MAX_MESSAGE_LENGTH = 16_000;
const localId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/**
 * Trims a finished turn's transient parts: the still-"…" stage-progress
 * lines (superseded by the tool's "Done:" status and the final answer) and
 * an assistant bubble that never received any text.
 */
const finalizeParts = (assistantId: string) => (current: ChatPart[]): ChatPart[] =>
  current.filter((part) =>
    part.type !== "tool-progress" &&
    (part.id !== assistantId || part.type !== "assistant" || part.text.length > 0),
  );

function parseEvent(block: string): ChatStreamEvent | null {
  const data = block.split("\n").filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return data ? { type: "done" } : null;
  return JSON.parse(data) as ChatStreamEvent;
}

async function readEvents(response: Response, onEvent: (event: ChatStreamEvent) => void) {
  if (!response.ok) throw new Error("The assistant could not start a response. Try again.");
  if (!response.body) throw new Error("The assistant returned an empty response. Try again.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) { const event = parseEvent(block); if (event) { completed ||= event.type === "done"; onEvent(event); } }
    if (done) break;
  }
  const event = parseEvent(buffer); if (event) { completed ||= event.type === "done"; onEvent(event); }
  if (!completed) throw new Error("The assistant response ended before it completed. Try again.");
}

export function useChatStream() {
  const [parts, setParts] = useState<ChatPart[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const controllerRef = useRef<AbortController | null>(null);
  const requestRef = useRef<{ text: string; boundary: ChatPart[] } | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = useCallback(async (text: string, boundary: ChatPart[]) => {
    if (!sessionId) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    requestRef.current = { text, boundary };
    const assistantId = localId("assistant");
    setParts([...boundary, { id: localId("user"), type: "user", text }, { id: assistantId, type: "assistant", text: "" }]);
    setStatus("streaming");
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, text }), signal: controller.signal });
      await readEvents(response, (event) => {
        if (event.type === "text-delta") setParts((current) => current.map((part) => part.id === assistantId && part.type === "assistant" ? { ...part, text: part.text + event.delta } : part));
        if (event.type === "tool-status") {
          const id = event.id ?? localId("tool");
          setParts((current) => { const index = current.findIndex((part) => part.id === id); const next: ChatPart = { id, type: "tool-status", label: event.label, state: event.state, response: event.response, reason: event.reason }; return index < 0 ? [...current, next] : current.map((part, i) => i === index ? next : part); });
        }
        // Stage progress replaces the previous stage for the same tool call
        // rather than stacking: the pipeline is linear, so one line that
        // advances reads better than six that accumulate.
        if (event.type === "tool-progress") {
          setParts((current) => {
            const next: ChatPart = { id: event.id, type: "tool-progress", toolCallId: event.toolCallId, state: event.state, label: event.label };
            const index = current.findIndex((part) => part.type === "tool-progress" && part.toolCallId === event.toolCallId);
            return index < 0 ? [...current, next] : current.map((part, i) => (i === index ? next : part));
          });
        }
        if (event.type === "generated-ui") setParts((current) => [...current.filter((part) => part.type !== "generated-ui" || part.view.instanceId !== event.view.instanceId), { id: event.id, type: "generated-ui", view: event.view }]);
        if (event.type === "citation-marker") {
          setParts((current) => current.map((part) => {
            if (part.id !== assistantId || part.type !== "assistant") return part;
            // Never crash and never render a marker twice: a repeated
            // marker `id` (distinct from `citationId`, which may
            // legitimately recur if the same source is cited at more
            // than one position) is dropped as a safe no-op.
            if ((part.citations ?? []).some((marker) => marker.id === event.id)) return part;
            return { ...part, citations: [...(part.citations ?? []), { id: event.id, citationId: event.citationId, sourceId: event.sourceId, position: event.position }] };
          }));
        }
        if (event.type === "citation-sources") {
          setParts((current) => {
            const seen = new Set<string>();
            const sources = event.sources.filter((source) => (seen.has(source.id) ? false : (seen.add(source.id), true)));
            return [...current, { id: localId("citation-sources"), type: "citation-sources", sources }];
          });
        }
        if (event.type === "error") throw Object.assign(new Error(event.message), { retryable: event.retryable });
      });
      if (!controller.signal.aborted) {
        setParts(finalizeParts(assistantId));
        setStatus("completed");
      }
    } catch (error) {
      if (controller.signal.aborted) { setParts(finalizeParts(assistantId)); setStatus("stopped"); }
      else {
        const message = error instanceof Error ? error.message : "The response failed. Try again.";
        const retryable = !(error instanceof Error && "retryable" in error && error.retryable === false);
        setParts((current) => [...finalizeParts(assistantId)(current), { id: localId("error"), type: "error", message, retryable }]);
        setStatus("failed");
      }
    } finally { if (controllerRef.current === controller) controllerRef.current = null; }
  }, [sessionId]);

  const send = useCallback((text: string) => void run(text.trim(), parts), [parts, run]);
  const stop = useCallback(() => controllerRef.current?.abort(), []);
  const retry = useCallback(() => { const request = requestRef.current; if (request) void run(request.text, request.boundary); }, [run]);
  const newSession = useCallback(() => { controllerRef.current?.abort(); requestRef.current = null; setParts([]); setStatus("idle"); setSessionId(crypto.randomUUID()); }, []);
  return { parts, status, sessionId, send, stop, retry, newSession, canSend: Boolean(sessionId) && status !== "streaming" };
}
