// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "../src/components/chat/chat-workspace";

const encoder = new TextEncoder();

function stream(...events: object[]) {
  return new Response(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } }), { status: 200 });
}

describe("ChatWorkspace", () => {
  beforeEach(() => {
    let id = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}` });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("sends with Enter, streams ordered text, and keeps composer focus", async () => {
    const fetchMock = vi.fn().mockResolvedValue(stream({ type: "text-delta", delta: "Hello " }, { type: "text-delta", delta: "there" }, { type: "done" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); render(<ChatWorkspace />);
    const composer = screen.getByRole("textbox", { name: "Message the assistant" });
    await user.type(composer, "Hi{enter}");
    expect(await screen.findByText("Hello there")).toBeInTheDocument();
    expect(composer).toHaveFocus();
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({ text: "Hi" });
    expect(request.sessionId).toMatch(/^00000000/);
  });

  it("uses Shift+Enter for a newline", async () => {
    vi.stubGlobal("fetch", vi.fn()); const user = userEvent.setup(); render(<ChatWorkspace />);
    const composer = screen.getByRole("textbox", { name: "Message the assistant" });
    await user.type(composer, "First{shift>}{enter}{/shift}Second");
    expect(composer).toHaveValue("First\nSecond"); expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects empty and oversized messages", async () => {
    vi.stubGlobal("fetch", vi.fn()); const user = userEvent.setup(); render(<ChatWorkspace />);
    const composer = screen.getByRole("textbox", { name: "Message the assistant" });
    await user.type(composer, "   {enter}");
    expect(screen.getByText("Enter a message first.")).toBeInTheDocument();
    await user.clear(composer);
    fireEvent.change(composer, { target: { value: "x".repeat(16_001) } });
    await user.keyboard("{Enter}");
    expect(screen.getByText(/Keep your message under 16,000 characters/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts a stream and announces the stopped state", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))));
    const user = userEvent.setup(); render(<ChatWorkspace />);
    await user.type(screen.getByRole("textbox"), "Wait{enter}");
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Response stopped");
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("retries from the original boundary without retaining the failed turn", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("no", { status: 503 })).mockResolvedValueOnce(stream({ type: "text-delta", delta: "Recovered" }, { type: "done" }));
    vi.stubGlobal("fetch", fetchMock); const user = userEvent.setup(); render(<ChatWorkspace />);
    await user.type(screen.getByRole("textbox"), "Again{enter}");
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered")).toBeInTheDocument();
    expect(screen.getAllByText("Again")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders an inline citation marker and its resolved source details on demand", async () => {
    const fetchMock = vi.fn().mockResolvedValue(stream(
      { type: "text-delta", delta: "The sky is blue." },
      { type: "citation-marker", id: "marker-1", citationId: "c1", sourceId: "s1", position: 3 },
      { type: "citation-sources", id: "sources-1", sources: [{ id: "s1", url: "https://example.com/sky", title: "Sky Facts", retrievedAt: "2026-08-22T00:00:00Z" }] },
      { type: "done" },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); render(<ChatWorkspace />);
    await user.type(screen.getByRole("textbox"), "Tell me{enter}");
    const marker = await screen.findByRole("button", { name: /Citation 1/ });
    expect(await screen.findByText("Sky Facts")).toBeInTheDocument();
    expect(marker).toHaveAttribute("aria-expanded", "false");
    await user.click(marker);
    expect(marker).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("note")).getByText("https://example.com")).toBeInTheDocument();
  });

  it("ignores a repeated citation-marker id without crashing or rendering a duplicate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(stream(
      { type: "text-delta", delta: "Fact one." },
      { type: "citation-marker", id: "marker-1", citationId: "c1", sourceId: "s1", position: 4 },
      { type: "citation-marker", id: "marker-1", citationId: "c1", sourceId: "s1", position: 4 },
      { type: "citation-sources", id: "sources-1", sources: [{ id: "s1", url: "https://example.com", title: "Example", retrievedAt: "2026-08-22T00:00:00Z" }] },
      { type: "done" },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); render(<ChatWorkspace />);
    await user.type(screen.getByRole("textbox"), "Hi{enter}");
    await screen.findByText("Sources");
    expect(screen.getAllByRole("button", { name: /Citation 1/ })).toHaveLength(1);
  });

  it("deduplicates repeated source ids within a citation-sources event", async () => {
    const fetchMock = vi.fn().mockResolvedValue(stream(
      { type: "text-delta", delta: "Fact." },
      {
        type: "citation-sources",
        id: "sources-1",
        sources: [
          { id: "s1", url: "https://example.com", title: "Example", retrievedAt: "2026-08-22T00:00:00Z" },
          { id: "s1", url: "https://example.com", title: "Example Duplicate", retrievedAt: "2026-08-22T00:00:00Z" },
        ],
      },
      { type: "done" },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); render(<ChatWorkspace />);
    await user.type(screen.getByRole("textbox"), "Hi{enter}");
    await screen.findByText("Sources");
    expect(screen.getAllByText("Example")).toHaveLength(1);
    expect(screen.queryByText("Example Duplicate")).not.toBeInTheDocument();
  });

  it("clears conversation and creates a new session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(stream({ type: "text-delta", delta: "Done" })); vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup(); render(<ChatWorkspace />);
    await user.type(screen.getByRole("textbox"), "Old{enter}"); await screen.findByText("Done");
    await user.click(screen.getByRole("button", { name: "New session" }));
    expect(screen.queryByText("Old")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "New{enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const first = JSON.parse(fetchMock.mock.calls[0][1].body); const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(first.sessionId).not.toBe(second.sessionId);
  });
});
