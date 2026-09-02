import "server-only";

import type { Browser, BrowserContext, Page, Response } from "playwright";
import {
  assertPublicDestination,
  normalizeCandidateUrl,
  readSourceOriginPolicy,
  type AddressLookup,
  type SourceOriginPolicy,
} from "../source-finding/url-policy";
import { sanitizeRenderedDocument } from "./sanitize";
import { UiGenerateStageError, type CaptureOutcome, type CaptureStage, type PageCapture, type ValidatedSource } from "../types";

/**
 * Stage 2 of `ui.generate`: the ordered, read-only Playwright capture loop
 * (P03-F02).
 *
 * Playwright is invoked **only from here**, only by fixed server code, and
 * only to read. There is no click, type, submit, upload, download,
 * permission grant, stored profile, API replay, or model-supplied script
 * anywhere in this file, and no interface that would let a caller ask for
 * one.
 *
 * Everything is bounded: pages per call, concurrency (one at a time, in the
 * order source finding returned), redirects per page, navigation time,
 * settle time, total time, and bytes per capture. An individual failure is
 * skipped; the stage fails only when no capture at all is usable.
 */

export interface CaptureBounds {
  readonly maxPages: number;
  readonly maxRedirects: number;
  readonly navigationTimeoutMs: number;
  readonly settleTimeoutMs: number;
  readonly perPageTotalMs: number;
  readonly totalMs: number;
  readonly maxHtmlBytes: number;
  readonly maxNodes: number;
}

export const DEFAULT_CAPTURE_BOUNDS: CaptureBounds = Object.freeze({
  maxPages: 6,
  maxRedirects: 5,
  navigationTimeoutMs: 20_000,
  settleTimeoutMs: 4_000,
  perPageTotalMs: 35_000,
  totalMs: 150_000,
  maxHtmlBytes: 400_000,
  maxNodes: 6_000,
});

/** Resource types that cost time and bytes but contribute nothing a planner can read. */
const BLOCKED_RESOURCE_TYPES = new Set(["font", "media", "websocket", "eventsource", "manifest"]);

export interface BrowserLease {
  readonly browser: Browser;
  release(): Promise<void>;
}

export type BrowserProvider = () => Promise<BrowserLease>;

/**
 * Lazily launches one headless Chromium for the process and hands out
 * leases. A single browser with a fresh, isolated, ephemeral context per
 * call is the right trade: contexts share no cookies, storage, cache, or
 * profile with each other or with anything the user has, while relaunching
 * a browser per request would dominate the stage's latency.
 */
export function createSharedChromiumProvider(): BrowserProvider {
  let pending: Promise<Browser> | null = null;
  return async () => {
    pending ??= (async () => {
      const { chromium } = await import("playwright");
      return chromium.launch({
        headless: true,
        args: ["--disable-dev-shm-usage", "--no-default-browser-check", "--disable-background-networking"],
      });
    })().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    const browser = await pending;
    return { browser, release: async () => {} };
  };
}

export interface CaptureOptions {
  readonly browserProvider: BrowserProvider;
  readonly bounds?: Partial<CaptureBounds>;
  readonly policy?: SourceOriginPolicy;
  readonly resolve?: AddressLookup;
  readonly now?: () => number;
  readonly log?: (line: Record<string, unknown>) => void;
}

function withDeadline(signal: AbortSignal, ms: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("deadline exceeded")), ms);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Re-validates every hop of a redirect chain. A URL that passed validation
 * before navigation says nothing about where it ended up, and a redirect to
 * a loopback or metadata address is the whole point of the attack this
 * guards against -- so each hop goes back through the same trusted policy.
 */
async function assertRedirectChainIsPublic(
  response: Response,
  bounds: CaptureBounds,
  policy: SourceOriginPolicy,
  resolve: AddressLookup | undefined,
): Promise<void> {
  const chain: string[] = [];
  let request = response.request();
  let hop: ReturnType<typeof request.redirectedFrom> = request.redirectedFrom();
  while (hop) {
    chain.push(hop.url());
    if (chain.length > bounds.maxRedirects) throw new Error("redirect limit exceeded");
    request = hop;
    hop = hop.redirectedFrom();
  }
  chain.push(response.url());
  for (const url of chain) {
    const normalized = normalizeCandidateUrl(url, policy);
    if (!normalized.ok) throw new Error(`redirect hop rejected: ${normalized.reason}`);
    const resolved = await assertPublicDestination(normalized.url, resolve);
    if (!resolved.ok) throw new Error(`redirect hop rejected: ${resolved.reason}`);
  }
}

/**
 * The fixed settle policy: wait for the network to go quiet, but never
 * longer than the settle bound, then take what has rendered. A client-side
 * app that keeps a socket open must not be able to hold the capture open
 * with it, so a settle timeout is a normal outcome rather than a failure.
 */
async function settle(page: Page, bounds: CaptureBounds): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: bounds.settleTimeoutMs });
  } catch {
    // Expected for long-polling pages; whatever rendered is what is captured.
  }
}

async function capturePage(
  context: BrowserContext,
  source: ValidatedSource,
  bounds: CaptureBounds,
  policy: SourceOriginPolicy,
  resolve: AddressLookup | undefined,
  now: () => number,
): Promise<PageCapture> {
  const startedAt = now();
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(bounds.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(bounds.navigationTimeoutMs);
    // Read-only, hard-stopped: a page cannot open a dialog, download, or
    // navigate the capture somewhere else through script.
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
    page.on("download", (download) => void download.cancel().catch(() => {}));

    const response = await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: bounds.navigationTimeoutMs });
    if (!response) throw new Error("navigation produced no response");
    if (!response.ok() && response.status() >= 400) throw new Error(`navigation returned HTTP ${response.status()}`);
    await assertRedirectChainIsPublic(response, bounds, policy, resolve);
    await settle(page, bounds);

    const finalUrl = page.url();
    const finalCheck = normalizeCandidateUrl(finalUrl, policy);
    if (!finalCheck.ok) throw new Error(`final URL rejected: ${finalCheck.reason}`);

    const sanitized = await page.evaluate(sanitizeRenderedDocument, {
      maxBytes: bounds.maxHtmlBytes,
      maxNodes: bounds.maxNodes,
    });
    if (sanitized.html.trim().length === 0) throw new Error("capture produced no content");

    return {
      sourceId: source.sourceId,
      requestedUrl: source.url,
      finalUrl: finalCheck.url,
      origin: finalCheck.origin,
      title: sanitized.title || finalCheck.origin,
      contentType: (response.headers()["content-type"] ?? "text/html").split(";")[0]!.trim().slice(0, 100),
      retrievedAt: new Date(now()).toISOString(),
      retrievalMs: now() - startedAt,
      html: sanitized.html,
      truncated: sanitized.truncated,
    };
  } finally {
    await page.close({ runBeforeUnload: false }).catch(() => {});
  }
}

export function createCaptureStage(options: CaptureOptions): CaptureStage {
  const bounds: CaptureBounds = { ...DEFAULT_CAPTURE_BOUNDS, ...options.bounds };
  const policy = options.policy ?? readSourceOriginPolicy();
  const now = options.now ?? Date.now;
  return {
    async capture({ sources, correlationId, signal }): Promise<CaptureOutcome> {
      const deadline = withDeadline(signal, bounds.totalMs);
      const captures: PageCapture[] = [];
      const failures: { sourceId: string; category: string }[] = [];
      let lease: BrowserLease | undefined;
      let context: BrowserContext | undefined;
      try {
        try {
          lease = await options.browserProvider();
        } catch (error) {
          throw new UiGenerateStageError("capture_failed", "The capture browser could not be started", { cause: error });
        }
        context = await lease.browser.newContext({
          // A fresh, ephemeral, profile-less context: no stored cookies, no
          // storage state, no permissions, no service workers.
          storageState: undefined,
          permissions: [],
          serviceWorkers: "block",
          javaScriptEnabled: true,
          bypassCSP: false,
          acceptDownloads: false,
          viewport: { width: 1_280, height: 900 },
          ignoreHTTPSErrors: false,
        });
        // Popups are closed rather than followed -- a capture reads exactly
        // the page it was pointed at.
        context.on("page", (opened) => {
          if (opened.opener() !== null) void opened.close().catch(() => {});
        });
        await context.route("**/*", (route) => {
          const type = route.request().resourceType();
          if (BLOCKED_RESOURCE_TYPES.has(type)) return void route.abort().catch(() => {});
          return void route.continue().catch(() => {});
        });

        for (const source of sources.slice(0, bounds.maxPages)) {
          if (deadline.signal.aborted) break;
          const pageDeadline = withDeadline(deadline.signal, bounds.perPageTotalMs);
          try {
            const capture = await Promise.race([
              capturePage(context, source, bounds, policy, options.resolve, now),
              new Promise<never>((_resolve, reject) => {
                pageDeadline.signal.addEventListener(
                  "abort",
                  () => reject(new Error("page budget exhausted")),
                  { once: true },
                );
              }),
            ]);
            captures.push(capture);
          } catch (error) {
            // An individual failure costs that source, not the request.
            failures.push({ sourceId: source.sourceId, category: categorize(error) });
          } finally {
            pageDeadline.dispose();
          }
        }
      } finally {
        // Everything this stage opened is closed here, on every path.
        await context?.close().catch(() => {});
        await lease?.release().catch(() => {});
        deadline.dispose();
      }

      options.log?.({
        stage: "page_capture",
        correlationId,
        requested: sources.length,
        captured: captures.length,
        failures: failures.map((failure) => failure.category),
        bytes: captures.reduce((total, capture) => total + capture.html.length, 0),
      });

      if (captures.length === 0) {
        if (signal.aborted) throw new UiGenerateStageError("cancelled", "Capture was cancelled");
        throw new UiGenerateStageError("capture_failed", "No source website could be captured");
      }
      return { captures, failures };
    },
  };
}

/** Coarse, safe failure category. Never carries the thrown message -- a browser error can quote page content. */
function categorize(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/redirect hop rejected|final URL rejected/.test(message)) return "policy_rejected";
  if (/redirect limit/.test(message)) return "redirect_limit";
  if (/budget exhausted|Timeout|timeout/.test(message)) return "timeout";
  if (/HTTP \d{3}/.test(message)) return "http_error";
  if (/no content/.test(message)) return "empty";
  return "navigation_failed";
}
