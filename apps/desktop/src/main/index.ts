/**
 * Electron main process entry point. Owns:
 *   - the per-launch services/browser auth token (never sent to the
 *     renderer, logged, or persisted -- see service-token.ts),
 *   - the services/browser child process lifecycle (browser-service.ts),
 *   - resolving/serving the renderer (renderer-target.ts),
 *   - the BrowserWindow and its security policy (window.ts),
 *   - the single allowlisted IPC handler backing the preload bridge.
 */

import { app, ipcMain, shell } from "electron";

import { AppInfoSchema, ShellOpenExternalResultSchema, validateExternalUrl } from "../shared/ipc-contract";
import { type BrowserServiceHandle, startBrowserService } from "./browser-service";
import { resolveBrowserServiceCwd, resolveRendererStandaloneServerPath } from "./paths";
import { type RendererTarget, resolveRendererTarget } from "./renderer-target";
import { generateServiceToken } from "./service-token";
import { createMainWindow, hardenDefaultSession } from "./window";

// Generated once per process launch. Intentionally not exported, not
// logged, and not written anywhere -- see docs/desktop-architecture-and-ui-specification.md,
// "Generate a random per-launch service credential; never send it to the
// renderer, model, logs, or persistent storage."
const serviceToken = generateServiceToken();

let browserService: BrowserServiceHandle | undefined;
let rendererTarget: RendererTarget | undefined;
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await Promise.allSettled([browserService?.stop(), rendererTarget?.stop()]);
}

app.on("web-contents-created", (_event, contents) => {
  // Defense in depth beyond window.ts's per-window will-navigate/
  // setWindowOpenHandler: deny at the app level too, in case a future
  // feature creates webContents outside createMainWindow (e.g. the
  // embedded live-browser <webview>/BrowserView in a later phase).
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.whenReady().then(async () => {
  hardenDefaultSession();

  try {
    browserService = await startBrowserService({
      serviceCwd: resolveBrowserServiceCwd(app.isPackaged),
      token: serviceToken,
    });

    rendererTarget = await resolveRendererTarget({
      isPackaged: app.isPackaged,
      standaloneServerPath: app.isPackaged ? resolveRendererStandaloneServerPath() : undefined,
      serverEnvironment: app.isPackaged ? {
        BROWSER_SERVICE_URL: browserService.baseUrl,
        BROWSER_SERVICE_TOKEN: serviceToken,
      } : undefined,
    });

    const win = createMainWindow({ allowedOrigins: [rendererTarget.url] });

    ipcMain.handle("app:get-info", () => {
      const info = AppInfoSchema.parse({
        name: app.getName(),
        version: app.getVersion(),
        electronVersion: process.versions.electron ?? "unknown",
        platform: process.platform,
        isPackaged: app.isPackaged,
      });
      return info;
    });

    // Deliberate, explicit exception to window.ts's default-deny
    // navigation/new-window policy: open a citation's destination URL in
    // the OS default browser, never inside this window. The URL is always
    // validated (http/https only) before being handed to
    // `shell.openExternal` -- never call it with unvalidated input, and
    // never throw an unhandled exception across the IPC boundary (an
    // invalid URL resolves to a typed failure instead).
    ipcMain.handle("shell:open-external", async (_event, rawUrl: unknown) => {
      const validated = validateExternalUrl(rawUrl);
      if (!validated.ok) {
        return ShellOpenExternalResultSchema.parse({ ok: false, reason: "invalid_url" });
      }
      try {
        await shell.openExternal(validated.url);
        return ShellOpenExternalResultSchema.parse({ ok: true });
      } catch {
        // shell.openExternal can reject (e.g. no OS handler for the
        // scheme) -- never let that become an unhandled rejection across
        // the IPC boundary.
        return ShellOpenExternalResultSchema.parse({ ok: false, reason: "open_failed" });
      }
    });

    await win.loadURL(rendererTarget.url);
  } catch (error) {
    // Startup failed (service never became ready, renderer never came up,
    // etc.) -- fail loudly and quit rather than showing a blank/broken
    // window. Intentionally no browserService/token details in this
    // message beyond the generic error.
    // eslint-disable-next-line no-console
    console.error("Failed to start AI-Native Browser:", error);
    await shutdown();
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void shutdown();
});

app.on("will-quit", () => {
  void shutdown();
});
