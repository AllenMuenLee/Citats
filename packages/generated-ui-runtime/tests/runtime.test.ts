import { describe, expect, it } from "vitest";
import {
  Card,
  Source,
  formatCurrency,
  formatDate,
  formatNumber,
  semanticTokens,
  type DisplaySource,
  type GeneratedViewProps,
  type OpaqueId,
} from "../src/index";

const opaque = (value: string) => value as OpaqueId;

describe("generated UI runtime authority", () => {
  it("exposes trusted source metadata and a lookup without a host command channel", () => {
    const props: GeneratedViewProps = {
      instanceRevision: 1,
      goal: "Compare items",
      sources: [],
      coverage: { requestedSources: 1, capturedSources: 0, note: null },
      getSource: () => undefined,
    };
    expect("dispatchCommand" in props).toBe(false);
    expect("getCapability" in props).toBe(false);
    expect("getRecord" in props).toBe(false);
    expect("records" in props).toBe(false);
  });

  it("keeps provenance non-navigating and non-loading", () => {
    const source: DisplaySource = {
      id: opaque("source-one"), title: "Example", origin: "example.com",
      finalUrl: "https://example.com/items", retrievedAt: "2026-08-25T00:00:00Z", captureStatus: "complete",
    };
    expect(Source({ source }).type).toBe("span");
    expect(JSON.stringify(Source({ source }))).not.toContain('"href"');
  });

  it("freezes semantic tokens and exposes only semantic values", () => {
    expect(Object.isFrozen(semanticTokens)).toBe(true);
    expect(Object.values(semanticTokens).every((value) => value.startsWith("var(--"))).toBe(true);
    expect(Card({ children: "Result" }).props.style.background).toBe(semanticTokens.surface);
  });

  it("provides pure bounded display formatters", () => {
    expect(formatNumber(1234, "en-US")).toBe("1,234");
    expect(formatCurrency(12, "USD", "en-US")).toContain("12.00");
    expect(formatDate("2026-08-25T00:00:00Z", "en-US")).toContain("2026");
  });
});
