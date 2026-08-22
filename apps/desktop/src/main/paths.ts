/**
 * Resolves filesystem locations that differ between dev (running straight
 * out of the monorepo) and a packaged build (running out of
 * process.resourcesPath, per the electron-builder `extraResources` config
 * in electron-builder.yml). Centralized here so index.ts stays a thin
 * `isPackaged` branch instead of scattering path math.
 */

import path from "node:path";

// dist/main/paths.js -> apps/desktop/dist/main -> apps/desktop -> apps -> repo root.
const MONOREPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

export function resolveBrowserServiceCwd(isPackaged: boolean): string {
  if (isPackaged) {
    // See electron-builder.yml extraResources: services/browser source is
    // copied to resources/services/browser. Running it still requires a uv
    // (or bundled Python) install on the target machine -- see the
    // packaging known-gap in docs/features/p00-f01-monorepo-environment.md.
    return path.join(process.resourcesPath, "services", "browser");
  }
  return path.join(MONOREPO_ROOT, "services", "browser");
}

export function resolveRendererStandaloneServerPath(): string {
  // Next.js `output: "standalone"` in an npm-workspaces monorepo mirrors
  // the workspace's path under .next/standalone/ (relative to the
  // outermost lockfile). extraResources copies that tree to
  // resources/renderer-standalone/ -- see electron-builder.yml.
  return path.join(process.resourcesPath, "renderer-standalone", "apps", "renderer", "server.js");
}
