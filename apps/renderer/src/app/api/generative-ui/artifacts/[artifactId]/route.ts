import { NextResponse } from "next/server";
import { getGeneratedUiArtifact } from "@/server/generative-ui/bridge/artifact-store";

export async function GET(_request: Request, context: { params: Promise<{ artifactId: string }> }): Promise<NextResponse> {
  const { artifactId } = await context.params;
  const stored = getGeneratedUiArtifact(artifactId);
  if (!stored) return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  const body = new ArrayBuffer(stored.bytes.byteLength);
  new Uint8Array(body).set(stored.bytes);
  return new NextResponse(body, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "private, max-age=60, immutable", "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff" } });
}
