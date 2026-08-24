import "server-only";

/**
 * Coordinates for reaching the local browser service, per
 * `.env.example`: `BROWSER_SERVICE_URL` may come from `.env.local` for
 * local development; `BROWSER_SERVICE_TOKEN` is never read from a `.env`
 * file -- apps/desktop's main process generates it per launch and injects
 * it directly into this server process's environment (packaged mode) or
 * a developer exports it manually alongside a locally-running
 * `services/browser` instance (dev mode). Returns `null` -- never
 * throws -- when either piece is missing, so the chat endpoint can
 * gracefully register only the tools that don't need the browser service
 * rather than failing to start.
 */
export interface BrowserServiceConfig {
  baseUrl: string;
  serviceToken: string;
}

export function readBrowserServiceConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BrowserServiceConfig | null {
  const baseUrl = environment.BROWSER_SERVICE_URL?.trim();
  const serviceToken = environment.BROWSER_SERVICE_TOKEN?.trim();
  if (!baseUrl || !serviceToken) return null;
  return { baseUrl, serviceToken };
}
