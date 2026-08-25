"use client";

import { Component, type ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { GeneratedUiMessageSchema, MAX_BRIDGE_MESSAGE_BYTES, type UiCommandMessage } from "../../server/generative-ui/bridge/protocol";
import styles from "./generated-ui-surface.module.css";

export type GeneratedUiSurfaceProps = Readonly<{
  instanceId: string;
  artifactId: string;
  inputDigest: string;
  observationDigest: string;
  revision: number;
  expiresAt: string;
  sourceCount: number;
  coverageLabel: string;
  fallback: ReactNode;
  onCommand: (command: UiCommandMessage["command"]) => void | Promise<void>;
  onTelemetry?: (event: "rendered" | "heartbeat" | "render_error" | "policy_violation") => void;
}>;

type BoundaryProps = Readonly<{ fallback: ReactNode; children: ReactNode }>;
class SurfaceBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(): void {}
  render(): ReactNode { return this.state.failed ? this.props.fallback : this.props.children; }
}

function randomChannel(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function GeneratedUiSurface(props: GeneratedUiSurfaceProps): ReactNode {
  const iframe = useRef<HTMLIFrameElement>(null);
  const lastSequence = useRef(0);
  const lastHeartbeat = useRef(0);
  const [height, setHeight] = useState(320);
  const [failed, setFailed] = useState(false);
  const [key, setKey] = useState(0);
  const [channel, setChannel] = useState(() => randomChannel());
  const src = `/api/generative-ui/sandbox#artifact=${encodeURIComponent(props.artifactId)}&channel=${channel}`;

  const destroy = useCallback(() => { setFailed(true); if (iframe.current) iframe.current.src = "about:blank"; }, []);

  useEffect(() => {
    lastHeartbeat.current = Date.now();
    const surface = iframe.current;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== "null") return;
      let size = Number.POSITIVE_INFINITY;
      try { size = new TextEncoder().encode(JSON.stringify(event.data)).byteLength; } catch {}
      if (size > MAX_BRIDGE_MESSAGE_BYTES) { destroy(); return; }
      const parsed = GeneratedUiMessageSchema.safeParse(event.data);
      if (!parsed.success) { destroy(); return; }
      const message = parsed.data;
      if (message.channel !== channel || message.instanceId !== props.instanceId || message.artifactId !== props.artifactId || message.inputDigest !== props.inputDigest || message.observationDigest !== props.observationDigest || message.revision !== props.revision || message.sequence !== lastSequence.current + 1) { destroy(); return; }
      lastSequence.current = message.sequence;
      lastHeartbeat.current = Date.now();
      if (message.type === "resize") setHeight(message.height);
      else if (message.type === "command") void Promise.resolve(props.onCommand(message.command)).catch(destroy);
      else if (message.type === "telemetry") { props.onTelemetry?.(message.event); if (message.event === "policy_violation") destroy(); }
      else if (message.type === "focus" && message.direction !== "inside") iframe.current?.focus();
    };
    window.addEventListener("message", onMessage);
    const monitor = window.setInterval(() => { if (Date.now() - lastHeartbeat.current > 15_000 || Date.parse(props.expiresAt) <= Date.now()) destroy(); }, 2_500);
    return () => { window.removeEventListener("message", onMessage); window.clearInterval(monitor); if (surface) surface.src = "about:blank"; };
  }, [channel, destroy, props]);

  if (failed) return <div className={styles.fallback} role="alert">{props.fallback}<button type="button" onClick={() => { lastSequence.current = 0; lastHeartbeat.current = Date.now(); setChannel(randomChannel()); setFailed(false); setKey((value) => value + 1); }}>Try generated view again</button></div>;
  return <SurfaceBoundary fallback={props.fallback}>
    <section className={styles.frame} aria-label="AI-generated view">
      <header className={styles.header}><span className={styles.label}>AI-generated view</span><span>{props.coverageLabel} · {props.sourceCount} {props.sourceCount === 1 ? "source" : "sources"}</span></header>
      <iframe ref={iframe} key={key} className={styles.surface} title="AI-generated task view" sandbox="allow-scripts" src={src} style={{ height }} referrerPolicy="no-referrer" allow="" />
      <footer className={styles.footer}><button type="button" onClick={destroy}>Show trusted fallback</button></footer>
    </section>
  </SurfaceBoundary>;
}
