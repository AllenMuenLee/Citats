import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["tests/e2e/**", "node_modules/**"],
    alias: {
      // `server-only` is a build-time marker Next.js resolves; under Vitest
      // it has no meaning and no package, so it maps to an empty module.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
});
