/**
 * BrowserWindow construction and the security policy attached to it.
 *
 * Per docs/desktop-architecture-and-ui-specification.md, "Desktop security
 * boundary":
 *   - contextIsolation enabled, nodeIntegration disabled, sandbox enabled.
 *   - Deny unexpected navigation, new windows, and permission requests by
 *     default.
 */

import path from "node:path";

import { BrowserWindow, session } from "electron";

/** Compiled preload script, output alongside this file by `tsc` (src/main -> dist/main, src/preload -> dist/preload). */
const PRELOAD_PATH = path.join(__dirname, "..", "preload", "index.js");

export interface CreateMainWindowOptions {
  /** Origins the window is allowed to load/navigate to (renderer dev/standalone server only). */
  allowedOrigins: readonly string[];
}

function isAllowedOrigin(urlString: string, allowedOrigins: readonly string[]): boolean {
  try {
    const url = new URL(urlString);
    return allowedOrigins.some((allowed) => url.origin === new URL(allowed).origin);
  } catch {
    return false;
  }
}

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD_PATH,
    },
  });

  // Deny unexpected navigation: only the renderer's own origin may be
  // navigated to (e.g. via window.location); everything else (including
  // the embedded live-browser pane in a later phase, which must render in
  // its own untrusted surface, not navigate this window) is refused.
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedOrigin(targetUrl, options.allowedOrigins)) {
      event.preventDefault();
    }
  });

  // Deny all new windows/popups by default. A later phase that needs an
  // explicit "open in system browser" affordance should allowlist that
  // action deliberately here, not remove this default-deny.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Deny all permission requests (camera, mic, geolocation, notifications,
  // etc.) by default. A later phase that needs a specific permission must
  // allowlist it explicitly and route it through a user-visible prompt.
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  return win;
}

/** Applies the same default-deny permission policy to the default session, for any window that might use it before a window-scoped session is set (defense in depth). */
export function hardenDefaultSession(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}
