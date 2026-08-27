import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a minimal self-contained server bundle (.next/standalone) that
  // apps/desktop spawns as a child process in a packaged build instead of
  // running `next start` against the full node_modules tree. See
  // docs/features/p00-f01-monorepo-environment.md, packaging section.
  output: "standalone",
  experimental: {
    // Next dev's HMR fetch cache snapshots every server-side fetch response
    // (on by default) by teeing its body outside of the caller's control.
    // For the provider SSE streams in server/ai/streaming.ts this races the
    // adapter's own stream consumption and throws `TypeError: unusable` from
    // the underlying undici fetch, surfacing as AI_PROVIDER_UNAVAILABLE.
    // Disable it -- it's a dev-only convenience, not needed for correctness.
    serverComponentsHmrCache: false,
  },
};

export default nextConfig;
