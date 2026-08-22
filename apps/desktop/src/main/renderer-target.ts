/**
 * Resolves the URL the BrowserWindow should load, and owns whatever child
 * process (if any) is needed to serve it. Deliberately a single function
 * with one `isPackaged` branch inside it (per the build steps: "Keep this
 * decision behind a small isPackaged branch, not two divergent code paths
 * that drift") rather than two separately-maintained modules.
 *
 * - Dev: apps/renderer's `next dev` server is already started by the root
 *   `npm run dev` orchestration (concurrently). We only poll it.
 * - Packaged: spawn the `.next/standalone` server Next.js produced via
 *   `output: "standalone"` (apps/renderer/next.config.ts) as a child
 *   process bound to 127.0.0.1 on a free port.
 *
 * No Electron imports -- only node:child_process / fetch -- so this stays
 * unit-testable outside the Electron runtime.
 */

import { type ChildProcess, spawn } from "node:child_process";

import { findFreeLoopbackPort } from "./find-free-port";

export interface RendererTarget {
  readonly url: string;
  stop(): Promise<void>;
}

export interface ResolveRendererTargetOptions {
  isPackaged: boolean;
  /** Dev only: where apps/renderer's `next dev` server is expected. */
  devServerUrl?: string;
  /** Packaged only: absolute path to the standalone server.js entry point. */
  standaloneServerPath?: string;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_DEV_SERVER_URL = "http://localhost:3000";
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

async function waitForHttpOk(url: string, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      // Next dev/standalone servers respond even for a 404; any HTTP
      // response at all means the server is accepting connections.
      if (response.status < 500) {
        return;
      }
      lastError = new Error(`${url} responded with status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

export async function resolveRendererTarget(options: ResolveRendererTargetOptions): Promise<RendererTarget> {
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (!options.isPackaged) {
    const url = options.devServerUrl ?? DEFAULT_DEV_SERVER_URL;
    await waitForHttpOk(url, waitTimeoutMs, pollIntervalMs);
    return {
      url,
      // The dev server's lifecycle belongs to the root `npm run dev`
      // process tree, not to us -- nothing to stop here.
      stop: async () => {},
    };
  }

  if (!options.standaloneServerPath) {
    throw new Error("standaloneServerPath is required when isPackaged is true");
  }

  const port = await findFreeLoopbackPort();
  const url = `http://127.0.0.1:${port}`;

  const child: ChildProcess = spawn(process.execPath, [options.standaloneServerPath], {
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  try {
    await waitForHttpOk(url, waitTimeoutMs, pollIntervalMs);
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

  return { url, stop };
}
