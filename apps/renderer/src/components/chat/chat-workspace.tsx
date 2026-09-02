"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStream } from "../../hooks/use-chat-stream";
import { GeneratedUiSurface } from "../generative-ui";
import { ChatComposer } from "./chat-composer";
import { MessageList } from "./message-list";
import styles from "./chat.module.css";

const statusText = { idle: "Ready", streaming: "Assistant is responding", stopped: "Response stopped", failed: "Response failed", completed: "Response complete" } as const;

/** P04-F04 step 7: the context pane's share of the workspace when it opens. */
const DEFAULT_PANE_PERCENT = 45;
const MIN_PANE_PERCENT = 25;
const MAX_PANE_PERCENT = 70;

export function ChatWorkspace() {
  const chat = useChatStream(); const [focusSignal, setFocusSignal] = useState(0);
  const [openGeneratedUiId, setOpenGeneratedUiId] = useState<string | null>(null);
  // Tracks which artifacts have already been auto-opened, so closing the
  // pane stays closed instead of springing back on the next render.
  const autoOpened = useRef(new Set<string>());
  const [panePercent, setPanePercent] = useState(DEFAULT_PANE_PERCENT);
  const [dragging, setDragging] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const act = (action: () => void) => { action(); setFocusSignal((value) => value + 1); };
  const openPart = chat.parts.find((part) => part.type === "generated-ui" && part.view.instanceId === openGeneratedUiId);
  const generatedUi = openPart?.type === "generated-ui" ? openPart : null;

  // A ready artifact opens its pane on its own (P04-F04 step 7): the view is
  // the answer for this turn, so it should not wait behind a second click.
  const latestGeneratedUi = [...chat.parts].reverse().find((part) => part.type === "generated-ui");
  useEffect(() => {
    if (latestGeneratedUi?.type !== "generated-ui") return;
    if (autoOpened.current.has(latestGeneratedUi.view.instanceId)) return;
    autoOpened.current.add(latestGeneratedUi.view.instanceId);
    setPanePercent(DEFAULT_PANE_PERCENT);
    setOpenGeneratedUiId(latestGeneratedUi.view.instanceId);
  }, [latestGeneratedUi]);

  const onResizeKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowLeft" ? -5 : event.key === "ArrowRight" ? 5 : 0;
    if (step === 0) return;
    event.preventDefault();
    setPanePercent((value) => Math.min(MAX_PANE_PERCENT, Math.max(MIN_PANE_PERCENT, value - step)));
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      const bounds = bodyRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width === 0) return;
      const percent = ((bounds.right - event.clientX) / bounds.width) * 100;
      setPanePercent(Math.min(MAX_PANE_PERCENT, Math.max(MIN_PANE_PERCENT, percent)));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [dragging]);

  return <main className={styles.workspace}>
    <header className={styles.header}><div><span className={styles.eyebrow}>AI workspace</span><h1>Conversation</h1></div><button className={styles.secondaryButton} type="button" onClick={() => act(() => { chat.newSession(); autoOpened.current.clear(); setOpenGeneratedUiId(null); })}>New session</button></header>
    <div ref={bodyRef} className={`${styles.body} ${generatedUi ? styles.split : ""}`}>
      <section className={styles.conversation} aria-label="Chat workspace">
        <div className={styles.scrollRegion}><MessageList parts={chat.parts} openGeneratedUiId={openGeneratedUiId} onOpenGeneratedUi={setOpenGeneratedUiId} /></div>
        {chat.status === "failed" && chat.parts.some((part) => part.type === "error" && part.retryable) && <div className={styles.recovery}><span>Nothing was changed.</span><button type="button" onClick={() => act(chat.retry)}>Retry</button></div>}
        <p className={styles.srOnly} role="status" aria-live="polite">{statusText[chat.status]}</p>
        <ChatComposer disabled={!chat.canSend} streaming={chat.status === "streaming"} onSubmit={chat.send} onStop={() => act(chat.stop)} focusSignal={focusSignal} />
      </section>
      {generatedUi && <>
        <div
          className={styles.paneResizer}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize generated view"
          aria-valuenow={Math.round(panePercent)}
          aria-valuemin={MIN_PANE_PERCENT}
          aria-valuemax={MAX_PANE_PERCENT}
          tabIndex={0}
          onKeyDown={onResizeKey}
          onPointerDown={(event) => { event.preventDefault(); setDragging(true); }}
        />
        <section className={styles.contextPane} aria-label="Generated view" style={{ flexBasis: `${panePercent}%` }}>
          <header className={styles.contextPaneHeader}>
            <span className={styles.partLabel}>Generated view</span>
            <button type="button" className={styles.secondaryButton} onClick={() => setOpenGeneratedUiId(null)}>Close</button>
          </header>
          <div className={styles.contextPaneBody}>
            <GeneratedUiSurface
              instanceId={generatedUi.view.instanceId}
              artifactId={generatedUi.view.artifactId}
              planDigest={generatedUi.view.planDigest}
              inputDigest={generatedUi.view.inputDigest}
              revision={generatedUi.view.revision}
              expiresAt={generatedUi.view.expiresAt}
              title={generatedUi.view.title}
              sourceCount={generatedUi.view.sourceCount}
              coverage={generatedUi.view.coverage}
              fallback={<p>{generatedUi.view.fallbackText}</p>}
            />
          </div>
        </section>
      </>}
    </div>
  </main>;
}
