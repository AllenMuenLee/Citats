"use client";

import { Component, type ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  GENERATED_UI_BRIDGE_VERSION,
  GeneratedUiMessageSchema,
  MAX_BRIDGE_MESSAGE_BYTES,
} from "../../server/generative-ui/bridge/protocol";
import styles from "./generated-ui-surface.module.css";

/**
 * The trusted frame around one generated view (P04-F04).
 *
 * The generated component renders inside an `allow-scripts`-only iframe --
 * no `allow-same-origin`, so it runs at a unique opaque origin with no
 * storage, no cookies, and no access to this document. Everything around it
 * -- the "AI-generated view" label, the source count, the coverage notice,
 * the controls, and the fallback -- is rendered here and cannot be replaced
 * by anything the generated code does.
 *
 * The bridge is one-in, four-out: this component sends `init` with the
 * display-safe props, and accepts only `ready`, `resize`, `focus`, and
 * `telemetry` back. Anything else -- a wrong origin, a wrong channel, a
 * mismatched digest, a stale revision, an out-of-order sequence, an
 * oversized payload -- destroys the surface rather than being interpreted.
 */
export type GeneratedUiSurfaceProps = Readonly<{
  instanceId: string;
  artifactId: string;
  implementationPromptDigest: string;
  inputDigest: string;
  revision: number;
  expiresAt: string;
  title: string;
  sourceCount: number;
  coverage: "validated" | "partial";
  fallback: ReactNode;
  onReady?: () => void;
  onTelemetry?: (event: "rendered" | "heartbeat" | "render_error" | "policy_violation") => void;
}>;

type BoundaryProps = Readonly<{ fallback: ReactNode; children: ReactNode }>;

class SurfaceBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(): void {}
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function randomChannel(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

const COVERAGE_LABEL: Readonly<Record<"validated" | "partial", string>> = {
  validated: "Validated coverage",
  partial: "Partial coverage",
};

export function GeneratedUiSurface(props: GeneratedUiSurfaceProps): ReactNode {
  const iframe = useRef<HTMLIFrameElement>(null);
  const lastSequence = useRef(0);
  const readyReported = useRef(false);
  const [height, setHeight] = useState(320);
  const [failed, setFailed] = useState(false);
  const [key, setKey] = useState(0);
  const [channel, setChannel] = useState(() => randomChannel());
  const src = `/api/generative-ui/sandbox#channel=${channel}`;

  const destroy = useCallback(() => {
    setFailed(true);
    if (iframe.current) iframe.current.src = "about:blank";
  }, []);

  const { instanceId, artifactId, implementationPromptDigest, inputDigest, revision, onReady, onTelemetry } = props;

  useEffect(() => {
    readyReported.current = false;
    lastSequence.current = 0;
    const surface = iframe.current;

    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== "null") return;
      let size = Number.POSITIVE_INFINITY;
      try {
        size = new TextEncoder().encode(JSON.stringify(event.data)).byteLength;
      } catch {
        /* unserializable payloads are over the limit by definition */
      }
      if (size > MAX_BRIDGE_MESSAGE_BYTES) return destroy();
      const parsed = GeneratedUiMessageSchema.safeParse(event.data);
      if (!parsed.success) return destroy();
      const message = parsed.data;
      if (
        message.channel !== channel ||
        message.instanceId !== instanceId ||
        message.artifactId !== artifactId ||
        message.implementationPromptDigest !== implementationPromptDigest ||
        message.inputDigest !== inputDigest ||
        message.revision !== revision ||
        message.sequence !== lastSequence.current + 1
      ) {
        return destroy();
      }
      lastSequence.current = message.sequence;
      if (message.type === "ready") {
        if (readyReported.current) return;
        readyReported.current = true;
        // Only a handshake that survived every check above is reported to the
        // trusted server, which re-checks it against its own instance state
        // before `ui.generate` is allowed to answer `ready`.
        void fetch("/api/generative-ui/ready", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ instanceId, artifactId, implementationPromptDigest, revision }),
        })
          .then(() => onReady?.())
          .catch(() => undefined);
      } else if (message.type === "resize") {
        setHeight(message.height);
      } else if (message.type === "telemetry") {
        onTelemetry?.(message.event);
        if (message.event === "policy_violation" || message.event === "render_error") destroy();
      } else if (message.type === "focus" && message.direction !== "inside") {
        iframe.current?.focus();
      }
    };

    // Display props are fetched from the trusted server by instance id
    // rather than carried on the chat stream, then forwarded as the one
    // inbound message the sandbox accepts.
    let cancelled = false;
    const onLoad = () => {
      void fetch(`/api/generative-ui/instances/${encodeURIComponent(instanceId)}`, { headers: { accept: "application/json" } })
        .then((response) => (response.ok ? (response.json() as Promise<{ displayProps: unknown }>) : Promise.reject(new Error("instance unavailable"))))
        .then((payload) => {
          if (cancelled) return;
          iframe.current?.contentWindow?.postMessage(
            {
              bridgeVersion: GENERATED_UI_BRIDGE_VERSION,
              type: "init",
              channel,
              instanceId,
              artifactId,
              implementationPromptDigest,
              inputDigest,
              revision,
              props: payload.displayProps,
            },
            "*",
          );
        })
        .catch(() => destroy());
    };

    window.addEventListener("message", onMessage);
    surface?.addEventListener("load", onLoad);
    // The src is driven here, not from JSX: a Strict Mode remount (and any
    // effect re-run) tears the frame down to about:blank in the cleanup
    // below, and only re-assigning it here brings the sandbox back. A JSX
    // `src` attribute is written once and never reapplied, so the frame
    // would stay blank and the `ready` handshake would never arrive.
    if (surface) surface.src = src;
    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
      surface?.removeEventListener("load", onLoad);
      if (surface) surface.src = "about:blank";
    };
  }, [src, channel, destroy, instanceId, artifactId, implementationPromptDigest, inputDigest, revision, onReady, onTelemetry, key]);

  if (failed) {
    return (
      <div className={styles.fallback} role="alert">
        {props.fallback}
        <button
          type="button"
          onClick={() => {
            lastSequence.current = 0;
            setChannel(randomChannel());
            setFailed(false);
            setKey((value) => value + 1);
          }}
        >
          Try generated view again
        </button>
      </div>
    );
  }

  return (
    <SurfaceBoundary fallback={props.fallback}>
      <section className={styles.frame} aria-label="AI-generated view">
        <header className={styles.header}>
          <span className={styles.label}>AI-generated view</span>
          <span>
            {COVERAGE_LABEL[props.coverage]} · {props.sourceCount} {props.sourceCount === 1 ? "source" : "sources"}
          </span>
        </header>
        <iframe
          ref={iframe}
          key={key}
          className={styles.surface}
          title={`AI-generated view: ${props.title}`}
          sandbox="allow-scripts"
          style={{ height }}
          referrerPolicy="no-referrer"
          allow=""
        />
        <footer className={styles.footer}>
          <button type="button" onClick={destroy}>
            Show trusted fallback
          </button>
        </footer>
      </section>
    </SurfaceBoundary>
  );
}
