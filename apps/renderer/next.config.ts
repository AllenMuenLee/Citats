import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a minimal self-contained server bundle (.next/standalone) that
  // apps/desktop spawns as a child process in a packaged build instead of
  // running `next start` against the full node_modules tree. See
  // docs/features/p00-f01-monorepo-environment.md, packaging section.
  output: "standalone",
};

export default nextConfig;
