import { Component, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as runtime from "./index";
import type { GeneratedViewProps } from "./index";

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
  mount(container: Element, props: GeneratedViewProps, onError: (code: string) => void): boolean;
  hasComponent(): boolean;
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
  mount(container, props, onError) {
    if (registered === null || root !== null) return false;
    root = createRoot(container, { onUncaughtError: () => onError("RENDER_THREW"), onCaughtError: () => onError("RENDER_THREW") });
    root.render(createElement(MountBoundary, { onError }, createElement(registered, props)));
    return true;
  },
};

Object.freeze(bridge);
(globalThis as unknown as { __generatedUiRuntime: SandboxBridge }).__generatedUiRuntime = bridge;
