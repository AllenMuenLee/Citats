/**
 * Finds a free loopback TCP port by binding to port 0 and reading back
 * whatever the OS assigned, then releasing it immediately. Used to pick
 * ports for the services/browser child process and, in a packaged build,
 * the spawned Next.js standalone server -- both must bind to 127.0.0.1
 * only, never 0.0.0.0 (see desktop security boundary: "never be exposed to
 * the LAN or internet").
 */

import { createServer } from "node:net";

export async function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to determine a free loopback port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
