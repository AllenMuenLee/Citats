import { Component, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as runtime from "./index";
import type { GeneratedViewProps, OpaqueId } from "./index";

/**
 * The sandbox-side entry point.
 *
 * esbuild bundles this file, React, and React DOM into one self-contained
 * IIFE served from the app's own origin, so the isolated surface needs no
 * import map, no CDN, and no network of its own -- which is what lets its
 * CSP stay `default-src 'none'; script-src 'self'`.
 *
 * It exposes exactly two things to the sandbox page: the frozen runtime the
 * generated module destructures from, and a `register`/`mount` pair the
 * bootstrap drives. The generated module itself never reaches any of this
 * directly; the compiler binds it to `__rt` and nothing else.
 */

type GeneratedViewComponent = (props: GeneratedViewProps) => ReactNode;

interface SandboxBridge {
  readonly runtime: typeof runtime;
  register(component: GeneratedViewComponent): void;
  mount(container: Element, rawProps: unknown, onError: (code: string) => void): boolean;
  hasComponent(): boolean;
}

/**
 * Builds the frozen `GeneratedViewProps` the component receives from the
 * display-safe payload the host forwarded. Functions cannot cross
 * `postMessage`, so `getSource` is reconstructed here over the supplied
 * source list -- the host never sends a callable.
 */
function buildProps(raw: unknown): GeneratedViewProps {
  const record = (raw ?? {}) as Record<string, unknown>;
  const sources = Array.isArray(record.sources) ? (record.sources as GeneratedViewProps["sources"]) : [];
  const byId = new Map(sources.map((source) => [source.id, source] as const));
  const coverage = (record.coverage ?? {}) as Record<string, unknown>;
  return Object.freeze({
    instanceRevision: typeof record.instanceRevision === "number" ? record.instanceRevision : 0,
    goal: typeof record.goal === "string" ? record.goal : "",
    sources,
    coverage: Object.freeze({
      requestedSources: typeof coverage.requestedSources === "number" ? coverage.requestedSources : sources.length,
      capturedSources: typeof coverage.capturedSources === "number" ? coverage.capturedSources : sources.length,
      note: typeof coverage.note === "string" ? coverage.note : null,
    }),
    getSource: (id: OpaqueId) => byId.get(id),
  });
}

class MountBoundary extends Component<{ readonly onError: (code: string) => void; readonly children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onError("RENDER_THREW");
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

let registered: GeneratedViewComponent | null = null;
let root: Root | null = null;

const bridge: SandboxBridge = {
  runtime,
  register(component) {
    // First registration wins: a second module cannot replace the view that
    // the host validated and served.
    if (registered === null && typeof component === "function") registered = component;
  },
  hasComponent() {
    return registered !== null;
  },
  mount(container, rawProps, onError) {
    if (registered === null || root !== null) return false;
    const props = buildProps(rawProps);
    root = createRoot(container, { onUncaughtError: () => onError("RENDER_THREW"), onCaughtError: () => onError("RENDER_THREW") });
    root.render(createElement(MountBoundary, { onError, children: createElement(registered, props) }));
    return true;
  },
};

Object.freeze(bridge);
(globalThis as unknown as { __generatedUiRuntime: SandboxBridge }).__generatedUiRuntime = bridge;
