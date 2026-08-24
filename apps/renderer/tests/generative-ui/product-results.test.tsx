// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { productResultPropsSchema } from "../../../../packages/contracts/src/ui/product-result";
import { ProductResults } from "../../src/components/generative-ui/product-results";
import { normalizeProductResults } from "../../src/server/generative-ui/product-results";
import { mixedCurrencyProductFixture, oneProductFixture, partialProductFixture, staleProductFixture } from "./product-results.fixtures";

afterEach(cleanup);

describe("product result contract and normalization", () => {
  it("rejects unsafe images and malformed prices", () => {
    expect(() => productResultPropsSchema.parse({ ...oneProductFixture, items: [{ ...oneProductFixture.items[0], image_url: "javascript:alert(1)" }] })).toThrow();
    expect(() => productResultPropsSchema.parse({ ...oneProductFixture, items: [{ ...oneProductFixture.items[0], price: { amount: "free", currency: "USD" } }] })).toThrow();
  });

  it("caps products and attributes and produces deterministic source-preserving order", () => {
    const input = { ...oneProductFixture, items: Array.from({ length: 60 }, (_, index) => ({ ...oneProductFixture.items[0], id: `id-${index}`, name: `Name ${59 - index}`, attributes: Array.from({ length: 12 }, (__, attribute) => ({ name: `A${attribute}`, value: "v" })) })) };
    const result = normalizeProductResults(input);
    expect(result.items).toHaveLength(50);
    expect(result.items[0]?.merchant).toBe("Example");
    expect(result.items.every((item) => item.price?.currency === "USD")).toBe(true);
  });
});

describe("ProductResults", () => {
  it("shows provenance, freshness, partial and stale states", () => {
    const { rerender } = render(<ProductResults {...partialProductFixture} now={new Date("2026-08-24T09:00:00Z")} />);
    expect(screen.getByText("Price unavailable")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Example merchant/ });
    expect(link).toHaveAttribute("href", "https://shop.example/products");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    rerender(<ProductResults {...staleProductFixture} now={new Date("2026-08-24T09:00:00Z")} />);
    expect(screen.getByText("Results may be out of date.")).toBeInTheDocument();
  });

  it("filters locally, announces sorting, and emits typed server commands", async () => {
    const onCommand = vi.fn(); const user = userEvent.setup();
    render(<ProductResults {...mixedCurrencyProductFixture} onCommand={onCommand} />);
    await user.type(screen.getByRole("textbox", { name: "Filter loaded results" }), "nothing");
    expect(screen.getByText("No loaded products match this filter.")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "price");
    expect(screen.getByText("Sorted by price")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Search for more" }));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ command_type: "product.filter", component_instance_id: "product-currencies", query_state: { query: "Quiet keyboards", filter: "nothing", sort: "price" } }));
  });

  it("keeps mixed currencies stable and cards keyboard reachable", async () => {
    const user = userEvent.setup(); render(<ProductResults {...mixedCurrencyProductFixture} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "price");
    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]).getByText(/US\$80\.00/)).toBeInTheDocument();
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("renders loading, error, and empty states", () => {
    const { rerender } = render(<ProductResults {...oneProductFixture} state="loading" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    rerender(<ProductResults {...oneProductFixture} state="error" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing was changed");
    rerender(<ProductResults {...oneProductFixture} items={[]} />);
    expect(screen.getByText("No loaded products match this filter.")).toBeInTheDocument();
  });
});
