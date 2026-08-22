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

import { AppInfoSchema, isAllowedChannel, type AppInfo } from "../shared/ipc-contract";

async function invokeAllowlisted(channel: string): Promise<unknown> {
  if (!isAllowedChannel(channel)) {
    throw new Error(`IPC channel "${channel}" is not allowlisted`);
  }
  return ipcRenderer.invoke(channel);
}

export interface DesktopBridge {
  appInfo: {
    get(): Promise<AppInfo>;
  };
}

const desktopBridge: DesktopBridge = {
  appInfo: {
    async get(): Promise<AppInfo> {
      const raw = await invokeAllowlisted("app:get-info");
      return AppInfoSchema.parse(raw);
    },
  },
};

contextBridge.exposeInMainWorld("desktop", desktopBridge);
