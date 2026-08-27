"use client";

import { useState } from "react";
import { useChatStream } from "../../hooks/use-chat-stream";
import { GeneratedUiSurface } from "../generative-ui";
import { ChatComposer } from "./chat-composer";
import { MessageList } from "./message-list";
import styles from "./chat.module.css";

const statusText = { idle: "Ready", streaming: "Assistant is responding", stopped: "Response stopped", failed: "Response failed", completed: "Response complete" } as const;

export function ChatWorkspace() {
  const chat = useChatStream(); const [focusSignal, setFocusSignal] = useState(0);
  const [openGeneratedUiId, setOpenGeneratedUiId] = useState<string | null>(null);
  const act = (action: () => void) => { action(); setFocusSignal((value) => value + 1); };
  const openPart = chat.parts.find((part) => part.type === "generated-ui" && part.instanceId === openGeneratedUiId);
  const generatedUi = openPart?.type === "generated-ui" ? openPart : null;
  return <main className={styles.workspace}>
    <header className={styles.header}><div><span className={styles.eyebrow}>AI workspace</span><h1>Conversation</h1></div><button className={styles.secondaryButton} type="button" onClick={() => act(() => { chat.newSession(); setOpenGeneratedUiId(null); })}>New session</button></header>
    <div className={`${styles.body} ${generatedUi ? styles.split : ""}`}>
      <section className={styles.conversation} aria-label="Chat workspace">
        <div className={styles.scrollRegion}><MessageList parts={chat.parts} openGeneratedUiId={openGeneratedUiId} onOpenGeneratedUi={setOpenGeneratedUiId} /></div>
        {chat.status === "failed" && chat.parts.some((part) => part.type === "error" && part.retryable) && <div className={styles.recovery}><span>Nothing was changed.</span><button type="button" onClick={() => act(chat.retry)}>Retry</button></div>}
        <p className={styles.srOnly} role="status" aria-live="polite">{statusText[chat.status]}</p>
        <ChatComposer disabled={!chat.canSend} streaming={chat.status === "streaming"} onSubmit={chat.send} onStop={() => act(chat.stop)} focusSignal={focusSignal} />
      </section>
      {generatedUi && <section className={styles.contextPane} aria-label="Generated view">
        <header className={styles.contextPaneHeader}>
          <span className={styles.partLabel}>Generated view</span>
          <button type="button" className={styles.secondaryButton} onClick={() => setOpenGeneratedUiId(null)}>Close</button>
        </header>
        <div className={styles.contextPaneBody}>
          <GeneratedUiSurface
            instanceId={generatedUi.instanceId} artifactId={generatedUi.artifactId} inputDigest={generatedUi.inputDigest}
            observationDigest={generatedUi.observationDigest} revision={generatedUi.revision} expiresAt={generatedUi.expiresAt}
            sourceCount={generatedUi.sourceCount} coverageLabel={generatedUi.coverageLabel}
            fallback={<p>{generatedUi.fallbackText}</p>}
            onCommand={async (command) => {
              const response = await fetch("/api/generative-ui/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instanceId: generatedUi.instanceId, revision: generatedUi.revision, ...command }) });
              if (!response.ok) throw new Error("Generated UI command was rejected");
            }}
          />
        </div>
      </section>}
    </div>
  </main>;
}
