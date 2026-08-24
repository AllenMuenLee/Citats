"use client";

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode; fallbackText: string; onError: () => void };
type State = { failed: boolean };

export class GenerativeUiErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State { return { failed: true }; }

  componentDidCatch() { this.props.onError(); }

  render() {
    if (this.state.failed) return <section role="alert"><strong>Generated view unavailable</strong><p>{this.props.fallbackText}</p></section>;
    return this.props.children;
  }
}
