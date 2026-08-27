/**
 * Liveness endpoint for the Next.js orchestrator frontend/backend process.
 *
 * Phase 0 scope: this route only proves the Next.js server process is up and
 * able to serve a request. It intentionally does not check downstream
 * dependencies (Postgres, Redis, the browser service, the model provider) -- that kind
 * of readiness check belongs to the FastAPI browser service's
 * `/health/ready` endpoint (see services/browser) and to future
 * orchestrator-specific health checks added in a later phase.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ status: "ok" });
}
