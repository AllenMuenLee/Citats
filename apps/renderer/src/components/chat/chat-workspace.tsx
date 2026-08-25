"use client";

import { useState } from "react";
import { useChatStream } from "../../hooks/use-chat-stream";
import { ChatComposer } from "./chat-composer";
import { MessageList } from "./message-list";
import styles from "./chat.module.css";

const statusText = { idle: "Ready", streaming: "Assistant is responding", stopped: "Response stopped", failed: "Response failed", completed: "Response complete" } as const;

export function ChatWorkspace() {
  const chat = useChatStream(); const [focusSignal, setFocusSignal] = useState(0);
  const act = (action: () => void) => { action(); setFocusSignal((value) => value + 1); };
  return <main className={styles.workspace}>
    <header className={styles.header}><div><span className={styles.eyebrow}>AI workspace</span><h1>Conversation</h1></div><button className={styles.secondaryButton} type="button" onClick={() => act(chat.newSession)}>New session</button></header>
    <section className={styles.conversation} aria-label="Chat workspace">
      <div className={styles.scrollRegion}><MessageList parts={chat.parts} /></div>
      {chat.status === "failed" && chat.parts.some((part) => part.type === "error" && part.retryable) && <div className={styles.recovery}><span>Nothing was changed.</span><button type="button" onClick={() => act(chat.retry)}>Retry</button></div>}
      <p className={styles.srOnly} role="status" aria-live="polite">{statusText[chat.status]}</p>
      <ChatComposer disabled={!chat.canSend} streaming={chat.status === "streaming"} onSubmit={chat.send} onStop={() => act(chat.stop)} focusSignal={focusSignal} />
    </section>
  </main>;
}
