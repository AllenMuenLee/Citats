"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MAX_MESSAGE_LENGTH } from "../../hooks/use-chat-stream";
import styles from "./chat.module.css";

type Props = { disabled: boolean; streaming: boolean; onSubmit: (text: string) => void; onStop: () => void; focusSignal: number };

export function ChatComposer({ disabled, streaming, onSubmit, onStop, focusSignal }: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => inputRef.current?.focus(), [focusSignal]);
  useEffect(() => {
    const input = inputRef.current;
    if (input) { input.style.height = "0px"; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; }
  }, [text]);
  const submit = (event?: FormEvent) => {
    event?.preventDefault(); const value = text.trim();
    if (!value) return setError("Enter a message first.");
    if (value.length > MAX_MESSAGE_LENGTH) return setError(`Keep your message under ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`);
    setError(""); setText(""); onSubmit(value);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!disabled) submit(); }
  };
  return <form className={styles.composer} onSubmit={submit}>
    <label className={styles.srOnly} htmlFor="chat-message">Message the assistant</label>
    <textarea id="chat-message" ref={inputRef} value={text} rows={1} maxLength={MAX_MESSAGE_LENGTH + 1}
      aria-describedby={error ? "composer-error" : "composer-hint"} aria-invalid={Boolean(error)} placeholder="Ask anything"
      onChange={(event) => { setText(event.target.value); setError(""); }} onKeyDown={keyDown} />
    <div className={styles.composerFooter}>
      <span id={error ? "composer-error" : "composer-hint"} className={error ? styles.validation : styles.hint}>{error || "Enter to send · Shift+Enter for a new line"}</span>
      {streaming ? <button className={styles.stopButton} type="button" onClick={onStop}>Stop</button> : <button className={styles.sendButton} type="submit" disabled={disabled || !text.trim()}>Send</button>}
    </div>
  </form>;
}
