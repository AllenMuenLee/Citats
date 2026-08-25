import { NextResponse } from "next/server";

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; navigate-to 'none'; base-uri 'none'; manifest-src 'none'";

export function GET(): NextResponse {
  const html = "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><link rel=stylesheet href=/api/generative-ui/sandbox/style></head><body><main id=root role=region aria-label=\"Generated content\"></main><script src=/api/generative-ui/sandbox/bootstrap defer></script></body></html>";
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-store", "referrer-policy": "no-referrer", "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), clipboard-read=(), clipboard-write=()", "x-content-type-options": "nosniff" } });
}
