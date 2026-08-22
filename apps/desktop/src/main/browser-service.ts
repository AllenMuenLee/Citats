/**
 * Owns the lifecycle of the Python browser service (services/browser) child
 * process: spawn it bound to loopback on a free port, wait for it to become
 * reachable and authenticated, and terminate it cleanly on app quit.
 *
 * No Electron imports here (only node:child_process / node:net-adjacent
 * APIs) so this module can be exercised under plain Node/Vitest; only
 * src/main/index.ts wires it to Electron's app lifecycle events.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { findFreeLoopbackPort } from "./find-free-port";

export interface BrowserServiceHandle {
  readonly port: number;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export interface StartBrowserServiceOptions {
  /** Absolute path to the services/browser package (contains pyproject.toml). */
  serviceCwd: string;
  /** Per-launch credential; passed to the child as BROWSER_SERVICE_TOKEN, never logged. */
  token: string;
  /** Max time to wait for /health/live then /health/ready to respond. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for readiness. */
  pollIntervalMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

async function waitForOk(url: string, headers: Record<string, string>, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} responded with status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for ${url} to become ready: ${String(lastError)}`);
}

/**
 * Spawns `uv run uvicorn browser_service.app:app` bound to 127.0.0.1 on a
 * free port, with BROWSER_SERVICE_TOKEN set in its environment. Resolves
 * once /health/live (unauthenticated) and /health/ready (authenticated via
 * X-Service-Token) both respond with HTTP 200 -- readiness here means "the
 * service is up and enforcing auth correctly", not that Postgres/Redis are
 * reachable (that is a separate, non-fatal signal surfaced in the
 * /health/ready response body for future UI to display).
 */
export async function startBrowserService(options: StartBrowserServiceOptions): Promise<BrowserServiceHandle> {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const port = await findFreeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    "uv",
    ["run", "uvicorn", "browser_service.app:app", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: options.serviceCwd,
      env: {
        ...process.env,
        BROWSER_SERVICE_TOKEN: options.token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Deliberately do not attach a listener that logs child.stdout/stderr
  // verbatim to a persistent sink here -- uvicorn does not echo the token,
  // but we avoid the risk entirely by not building any logging path that
  // could be extended to include process env in the future.

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  try {
    await waitForOk(`${baseUrl}/health/live`, {}, readyTimeoutMs, pollIntervalMs);
    await waitForOk(
      `${baseUrl}/health/ready`,
      { "X-Service-Token": options.token },
      readyTimeoutMs,
      pollIntervalMs,
    );
  } catch (error) {
    if (!exited) {
      child.kill("SIGTERM");
    }
    throw error;
  }

  async function stop(): Promise<void> {
    if (exited || child.exitCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        if (!exited) {
          child.kill("SIGKILL");
        }
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(forceKillTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  return { port, baseUrl, stop };
}
