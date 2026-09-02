import "server-only";

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Builds the sandbox runtime bundle: React, React DOM, and
 * `@ai-browser/generated-ui-runtime` compiled into one self-contained IIFE
 * served from the app's own origin.
 *
 * This is what lets the isolated surface keep
 * `default-src 'none'; script-src 'self'` -- there is no CDN, no import
 * map, no module graph to resolve at runtime, and no network fetch of any
 * kind from inside the sandbox.
 *
 * The bundle is built once per process and cached. It is fixed application
 * code, not generated code: the compiler that produces a *generated view*
 * (`compiler/compiler.ts`) installs nothing and reads no path, and nothing
 * a model returns reaches this build.
 */
let cached: Promise<{ code: string; etag: string }> | null = null;

export function generatedUiRuntimeBundle(): Promise<{ code: string; etag: string }> {
  cached ??= build().catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}

async function build(): Promise<{ code: string; etag: string }> {
  const esbuild = await import("esbuild");
  const require = createRequire(import.meta.url);
  const entry = join(dirname(require.resolve("@ai-browser/generated-ui-runtime/package.json")), "src", "sandbox-entry.tsx");
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    jsx: "automatic",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error("generated UI runtime bundle produced no output");
  return { code, etag: `"${createHash("sha256").update(code).digest("hex").slice(0, 32)}"` };
}
