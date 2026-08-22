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

/** IPC channel names the preload bridge is allowed to invoke. */
export const ALLOWED_CHANNELS = ["app:get-info"] as const;

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
