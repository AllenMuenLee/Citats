/**
 * Preload script: the only bridge between the untrusted renderer and the
 * main process. Exposes a small, explicit, typed API via contextBridge --
 * never ipcRenderer, require, process, or any generic passthrough (see
 * docs/desktop-architecture-and-ui-specification.md, desktop security
 * boundary).
 *
 * Every exposed method is backed by one entry in ALLOWED_CHANNELS
 * (src/shared/ipc-contract.ts) and validates the main process's response
 * against a zod schema before it reaches renderer code -- so a bug that
 * makes main return something unexpected fails loudly in preload instead
 * of silently handing malformed data to the renderer.
 */

import { contextBridge, ipcRenderer } from "electron";

import {
  AppInfoSchema,
  isAllowedChannel,
  ShellOpenExternalResultSchema,
  type AppInfo,
  type ShellOpenExternalResult,
} from "../shared/ipc-contract";

async function invokeAllowlisted(channel: string, arg?: unknown): Promise<unknown> {
  if (!isAllowedChannel(channel)) {
    throw new Error(`IPC channel "${channel}" is not allowlisted`);
  }
  return ipcRenderer.invoke(channel, arg);
}

export interface DesktopBridge {
  appInfo: {
    get(): Promise<AppInfo>;
  };
  links: {
    /**
     * Opens `url` in the OS default browser via the main process (never
     * inside this window -- see window.ts's default-deny navigation
     * policy). Never throws for an invalid URL: resolves to
     * `{ ok: false, reason: "invalid_url" }` instead.
     */
    openExternal(url: string): Promise<ShellOpenExternalResult>;
  };
}

const desktopBridge: DesktopBridge = {
  appInfo: {
    async get(): Promise<AppInfo> {
      const raw = await invokeAllowlisted("app:get-info");
      return AppInfoSchema.parse(raw);
    },
  },
  links: {
    async openExternal(url: string): Promise<ShellOpenExternalResult> {
      const raw = await invokeAllowlisted("shell:open-external", url);
      return ShellOpenExternalResultSchema.parse(raw);
    },
  },
};

contextBridge.exposeInMainWorld("desktop", desktopBridge);
