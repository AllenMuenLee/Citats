import { NextResponse } from "next/server";
import { generatedUiRuntimeBundle } from "@/server/generative-ui/bridge/runtime-bundle";

export const runtime = "nodejs";

/**
 * Serves the sandbox runtime bundle -- React, React DOM, and the frozen
 * generated-UI runtime -- from this app's own origin, which is what lets
 * the sandbox keep `default-src 'none'; script-src 'self'` with no CDN and
 * no network access of its own.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const bundle = await generatedUiRuntimeBundle();
  if (request.headers.get("if-none-match") === bundle.etag) {
    return new NextResponse(null, { status: 304, headers: { etag: bundle.etag } });
  }
  return new NextResponse(bundle.code, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "private, max-age=3600",
      etag: bundle.etag,
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
