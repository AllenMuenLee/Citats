import { NextResponse } from "next/server";

/**
 * The origin-isolated surface a generated view renders in (P04-F04 step 1).
 *
 * The CSP denies everything by default and re-allows only same-origin
 * script and style: no network, no navigation, no form action, no frame, no
 * worker, no object, and no base URI. Combined with the iframe's own
 * `sandbox="allow-scripts"` -- which withholds `allow-same-origin`, so the
 * document runs at a unique opaque origin with no storage of any kind --
 * there is no Node, no Electron, no preload, and no host API reachable from
 * inside it.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'none'",
  "media-src 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "manifest-src 'none'",
].join("; ");

const HTML = '<!doctype html><html><head><meta charset=utf-8>'
  + '<meta name=viewport content="width=device-width,initial-scale=1">'
  + '<link rel=stylesheet href=/api/generative-ui/sandbox/style></head>'
  + '<body><main id=root role=region aria-label="Generated content"></main>'
  + '<script src=/api/generative-ui/sandbox/runtime></script>'
  + '<script src=/api/generative-ui/sandbox/bootstrap defer></script></body></html>';

export function GET(): NextResponse {
  return new NextResponse(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "permissions-policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), clipboard-read=(), clipboard-write=(), display-capture=(), midi=()",
      "x-content-type-options": "nosniff",
    },
  });
}
