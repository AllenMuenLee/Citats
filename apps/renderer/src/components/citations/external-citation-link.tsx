"use client";

import type { ReactNode } from "react";
import { isSafeExternalUrl } from "./url-safety";
import styles from "./citations.module.css";

/**
 * Minimal shape of the desktop preload bridge this component needs
 * (`apps/desktop/src/preload/index.ts`'s `desktopBridge.links.openExternal`).
 * Declared locally rather than imported: `apps/renderer` and
 * `apps/desktop` are separate apps/build targets (Next.js renderer vs.
 * Electron main/preload), so the renderer never depends on desktop source.
 */
interface DesktopLinksBridge {
  links?: {
    openExternal?: (url: string) => Promise<unknown>;
  };
}

declare global {
  interface Window {
    desktop?: DesktopLinksBridge;
  }
}

/**
 * The only sanctioned way to open a citation's destination URL. Electron's
 * window policy denies all in-window navigation and new windows by default
 * (see `apps/desktop/src/main/window.ts`), so this never renders a plain
 * `<a target="_blank">` -- it calls the preload-exposed
 * `window.desktop.links.openExternal` API, which opens the URL in the OS
 * default browser from the main process (after that process re-validates
 * it). If `window.desktop` is unavailable (tests, a non-Electron preview),
 * the control still renders but clicking it is a safe no-op.
 *
 * Defense in depth: only ever renders an interactive control for a URL
 * that already passes `isSafeExternalUrl` (http/https only); anything else
 * renders as inert text instead of a clickable action.
 */
export function ExternalCitationLink({ url, children }: { url: string; children: ReactNode }) {
  if (!isSafeExternalUrl(url)) {
    return (
      <span className={styles.unsafeLink}>
        {children}
        <span className={styles.srOnly}> (link unavailable: unsupported URL)</span>
      </span>
    );
  }

  const handleClick = () => {
    const openExternal = typeof window === "undefined" ? undefined : window.desktop?.links?.openExternal;
    if (!openExternal) return;
    void openExternal(url);
  };

  return (
    <button type="button" className={styles.externalLink} onClick={handleClick}>
      {children}
      <span aria-hidden="true" className={styles.externalLinkIcon}>
        ↗
      </span>
      <span className={styles.srOnly}> (opens in your default browser)</span>
    </button>
  );
}
