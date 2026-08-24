/**
 * Shared IPC contract between the Electron main process and the preload
 * script. This is the single source of truth for:
 *   - which IPC channels the preload script is allowed to invoke at all
 *     (ALLOWED_CHANNELS -- anything not in this list is refused by the
 *     typed wrapper in src/preload/index.ts before it ever reaches
 *     ipcRenderer), and
 *   - the schema every response is validated against before it is handed
 *     to renderer code, via zod.
 *
 * Per docs/desktop-architecture-and-ui-specification.md's desktop security
 * boundary: "Expose only a small typed preload API through contextBridge;
 * never expose generic IPC... Validate every IPC request and response with
 * shared schemas." Chat/browsing isn't implemented yet (non-goal of P00),
 * so today this is a single read-only "app info" channel -- but every
 * future channel other features add must be registered here the same way,
 * not called ad hoc from ipcRenderer.
 */

import { z } from "zod";
import { HttpUrlSchema } from "@ai-browser/contracts";

/** IPC channel names the preload bridge is allowed to invoke. */
export const ALLOWED_CHANNELS = ["app:get-info", "shell:open-external"] as const;

export type AllowedChannel = (typeof ALLOWED_CHANNELS)[number];

export function isAllowedChannel(channel: string): channel is AllowedChannel {
  return (ALLOWED_CHANNELS as readonly string[]).includes(channel);
}

/** Response schema for the "app:get-info" channel. */
export const AppInfoSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    electronVersion: z.string(),
    platform: z.string(),
    isPackaged: z.boolean(),
  })
  .strict();

export type AppInfo = z.infer<typeof AppInfoSchema>;

/**
 * Response schema for the "shell:open-external" channel. `window.ts` denies
 * all in-window navigation/new-windows by default (see that file); this is
 * the single, deliberate, explicit exception -- opening a citation's
 * destination URL in the OS default browser, never inside the app window.
 * The main-process handler never throws across the IPC boundary: an
 * invalid URL resolves to `{ ok: false, reason: "invalid_url" }` rather
 * than an unhandled rejection.
 */
export const ShellOpenExternalResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(["invalid_url", "open_failed"]) }).strict(),
]);

export type ShellOpenExternalResult = z.infer<typeof ShellOpenExternalResultSchema>;

/**
 * Validates a value claiming to be a URL to open externally: must be a
 * string accepted by `HttpUrlSchema` (absolute, `http`/`https` only --
 * rejects `javascript:`, `file:`, `data:`, malformed strings, non-string
 * input, etc.). Extracted as a standalone, Electron-free function so it can
 * be unit-tested directly (see `tests/shell-open-external.test.ts`) and so
 * the IPC handler in `src/main/index.ts` never calls
 * `shell.openExternal` with unvalidated input.
 */
export function validateExternalUrl(value: unknown): { ok: true; url: string } | { ok: false; reason: "invalid_url" } {
  if (typeof value !== "string") {
    return { ok: false, reason: "invalid_url" };
  }
  const result = HttpUrlSchema.safeParse(value);
  if (!result.success) {
    return { ok: false, reason: "invalid_url" };
  }
  return { ok: true, url: result.data };
}
