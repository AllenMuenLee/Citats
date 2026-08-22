/**
 * Per-launch credential for authenticating main-process -> services/browser
 * calls. Generated fresh every app start; never persisted, logged, or sent
 * to the renderer (see docs/desktop-architecture-and-ui-specification.md,
 * "Generate a random per-launch service credential; never send it to the
 * renderer, model, logs, or persistent storage").
 *
 * Kept in its own module (no Electron imports) so it can be unit tested
 * under plain Node/Vitest without an Electron runtime.
 */

import { randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

/** Generates a fresh random per-launch service token (hex-encoded). */
export function generateServiceToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}
