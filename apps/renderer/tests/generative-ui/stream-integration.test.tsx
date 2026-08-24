// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "../../src/components/chat/chat-workspace";

const encoder = new TextEncoder();

const productPart = {
  component_type: "product_results",
  schema_version: "1.0",
  instance_id: "instance-stream-1",
  result_digest: "a".repeat(64),
  props: {
    component_instance_id: "instance-stream-1",
    query: "travel headphones",
    items: [{ id: "product-1", name: "Quiet Set", price: { amount: "120", currency: "USD" }, merchant: "Example", availability: "Available", attributes: [], source_ids: ["source-1"], partial_data_warnings: [] }],
    sources: [{ source_id: "source-1", title: "Example products", url: "https://example.test/products" }],
    freshness: { retrieved_at: "2026-08-24T10:00:00+08:00" },
    warnings: [],
  },
  provenance: { invocation_id: "invocation-1", sources: [{ source_id: "source-1", title: "Example products", url: "https://example.test/products" }] },
  allowed_commands: [{ command_type: "product.refresh", schema_version: "1.0" }],
  correlation_id: "correlation-1",
  freshness: { retrieved_at: "2026-08-24T10:00:00+08:00" },
  warnings: [],
  fallback_text: "Quiet Set is available from Example for USD 120.",
};

function chunkedEvent(event: object) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  const midpoint = Math.floor(frame.length / 2);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frame.slice(0, midpoint)));
      controller.enqueue(encoder.encode(frame.slice(midpoint)));
      controller.close();
    },
  }), { status: 200 });
}

describe("generative UI chat stream", () => {
  beforeEach(() => {
    let id = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}` });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("buffers a partial SSE frame and renders a validated product view", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(chunkedEvent({ type: "generative-ui", payload: productPart })));
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await user.type(screen.getByRole("textbox"), "Compare headphones{enter}");
    expect(await screen.findByRole("heading", { name: "travel headphones" })).toBeInTheDocument();
    expect(screen.getByText("Quiet Set")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Example products/ })).toHaveAttribute("href", "https://example.test/products");
  });

  it("uses escaped text fallback for a schema version mismatch", async () => {
    const payload = { ...productPart, schema_version: "9.9", fallback_text: "Safe <script> text fallback" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(chunkedEvent({ type: "generative-ui", payload })));
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await user.type(screen.getByRole("textbox"), "Compare{enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Safe <script> text fallback");
    expect(document.querySelector("script")).toBeNull();
  });
});
