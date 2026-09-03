import { describe, expect, it, vi } from "vitest";
import { createCaptureStage, type BrowserLease } from "../../src/server/ui-generate/capture/playwright-capture";
import type { ValidatedSource } from "../../src/server/ui-generate/types";

const resolvePublic = vi.fn(async () => ["93.184.216.34"]);
const sources: ValidatedSource[] = [
  { sourceId: "src-1", url: "https://one.example/", origin: "https://one.example", reason: "one" },
  { sourceId: "src-2", url: "https://two.example/", origin: "https://two.example", reason: "two" },
];

function fakeLease(outcomes: readonly ("ok" | "fail")[]) {
  const closed: string[] = [];
  let next = 0;
  const pageListeners: ((opened: unknown) => void)[] = [];
  const context = {
    on: vi.fn((event: string, handler: (opened: unknown) => void) => {
      if (event === "page") pageListeners.push(handler);
    }),
    pageListeners,
    route: vi.fn(),
    close: vi.fn(async () => { closed.push("context"); }),
    newPage: vi.fn(async () => {
      const outcome = outcomes[next++] ?? "ok";
      let navigationRoute: ((route: unknown) => Promise<void>) | undefined;
      const page = {
        setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(), on: vi.fn(),
        route: vi.fn(async (_pattern: string, handler: (route: unknown) => Promise<void>) => { navigationRoute = handler; }),
        close: vi.fn(async () => { closed.push("page"); }),
        waitForLoadState: vi.fn(async () => {}),
        url: vi.fn(() => `https://${next === 1 ? "one" : "two"}.example/`),
        evaluate: vi.fn(async () => ({ html: `<html><body>site-${next}</body></html>`, title: `Site ${next}`, truncated: false })),
        goto: vi.fn(async (url: string) => {
          const route = {
            request: () => ({ isNavigationRequest: () => true, url: () => url }),
            continue: vi.fn(async () => {}),
            abort: vi.fn(async () => {}),
          };
          await navigationRoute?.(route);
          if (outcome === "fail") throw new Error("navigation failed");
          const request = { url: () => url, redirectedFrom: () => null };
          return { ok: () => true, status: () => 200, request: () => request, url: () => url, headers: () => ({ "content-type": "text/html; charset=utf-8" }) };
        }),
      };
      return page;
    }),
  };
  const release = vi.fn(async () => { closed.push("lease"); });
  const lease = { browser: { newContext: vi.fn(async () => context) }, release } as unknown as BrowserLease;
  return { lease, context, release, closed };
}

describe("Playwright rendered-HTML capture", () => {
  it("captures successful sources in order and closes every owned resource", async () => {
    const fake = fakeLease(["ok", "ok"]);
    const stage = createCaptureStage({ browserProvider: async () => fake.lease, resolve: resolvePublic });
    const result = await stage.capture({ sources, correlationId: "capture-1", signal: new AbortController().signal });
    expect(result.captures.map((capture) => capture.sourceId)).toEqual(["src-1", "src-2"]);
    expect(result.captures.map((capture) => capture.html)).toEqual([
      "<html><body>site-1</body></html>", "<html><body>site-2</body></html>",
    ]);
    expect(fake.context.newPage).toHaveBeenCalledTimes(2);
    expect(fake.closed.filter((item) => item === "page")).toHaveLength(2);
    expect(fake.closed.slice(-2)).toEqual(["context", "lease"]);
  });

  it("closes popups but leaves self-opened pages alone", async () => {
    const fake = fakeLease(["ok", "ok"]);
    await createCaptureStage({ browserProvider: async () => fake.lease, resolve: resolvePublic })
      .capture({ sources, correlationId: "capture-popup", signal: new AbortController().signal });
    expect(fake.context.pageListeners).toHaveLength(1);
    const onPage = fake.context.pageListeners[0]!;

    const selfOpened = { opener: vi.fn(async () => null), close: vi.fn(async () => {}) };
    onPage(selfOpened);
    await new Promise((resolve) => setImmediate(resolve));
    expect(selfOpened.close).not.toHaveBeenCalled();

    const popup = { opener: vi.fn(async () => ({})), close: vi.fn(async () => {}) };
    onPage(popup);
    await new Promise((resolve) => setImmediate(resolve));
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  it("continues after an individual failure but fails when none are usable", async () => {
    const partial = fakeLease(["fail", "ok"]);
    const result = await createCaptureStage({ browserProvider: async () => partial.lease, resolve: resolvePublic })
      .capture({ sources, correlationId: "capture-2", signal: new AbortController().signal });
    expect(result.captures.map((capture) => capture.sourceId)).toEqual(["src-2"]);
    expect(result.failures).toEqual([{ sourceId: "src-1", category: "navigation_failed" }]);

    const failed = fakeLease(["fail", "fail"]);
    await expect(createCaptureStage({ browserProvider: async () => failed.lease, resolve: resolvePublic })
      .capture({ sources, correlationId: "capture-3", signal: new AbortController().signal }))
      .rejects.toMatchObject({ category: "capture_failed" });
    expect(failed.closed.slice(-2)).toEqual(["context", "lease"]);
  });

  it("honors cancellation before acquiring browser resources", async () => {
    const provider = vi.fn(async () => fakeLease(["ok"]).lease);
    const controller = new AbortController();
    controller.abort();
    await expect(createCaptureStage({ browserProvider: provider, resolve: resolvePublic })
      .capture({ sources, correlationId: "capture-4", signal: controller.signal }))
      .rejects.toMatchObject({ category: "cancelled" });
    expect(provider).not.toHaveBeenCalled();
  });
});
