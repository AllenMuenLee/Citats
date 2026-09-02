"""Local static/dynamic HTTP fixture server used only by this package's own
navigation tests.

Not imported by any production code path -- exists purely so tests can
drive real headless Chromium (via Playwright) against a real local HTTP
server without touching the public internet. Serves static pages from
``pages/`` plus a few dynamic routes needed to exercise redirect,
oversized-response, and slow-response handling:

``/redirect?to=<url-encoded-target>``
    Responds 302 with ``Location: <target>`` (used to build both
    single-hop and multi-hop redirect chains toward allowed or blocked
    targets).
``/oversized?bytes=<n>``
    Responds 200 with a declared ``Content-Length: <n>`` body of that
    exact size (used to exercise the response-size cap).
``/slow?seconds=<n>``
    Sleeps ``n`` seconds before responding 200 with a tiny body (used to
    exercise idle-timeout behavior distinctly from total-timeout).
``/api/echo``
    GET or POST, always responds 200 with a tiny ``application/json`` body
    (``{"ok": true}``). Never reflects request headers/query/body back --
    it exists only so tests can drive real XHR/fetch traffic (used by
    ``test_network_capture.py``); the request side is what capture/
    redaction tests care about, not the response.
``/api/big``
    Responds 200 with an oversized ``application/json`` body (used to
    exercise the network-capture body size cap against a real response).
``/api/binary``
    Responds 200 with a tiny non-text ``image/png`` body (used to exercise
    binary-body skip handling against real network capture).
``/api/products``, ``/api/accommodation``, ``/api/flights``, ``/api/generic-records``
    Each responds 200 with a small ``application/json`` body of a different
    recognized/unrecognized shape (product list, hotel/room list -- same
    ``products`` shape as a different vertical, flight list, and an
    unrecognized-key list respectively), used by the adaptive
    navigate+discover scenario tests to prove endpoint-map inference and
    result-kind classification generalize across site shapes rather than
    being hardcoded to one.
"""

from __future__ import annotations

import http.server
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

PAGES_DIR = Path(__file__).parent / "pages"

# 1x1 transparent PNG.
_TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108020000009077"
    "53de0000000c4944415478da6360000002000155a2d0aa0000000049454e44"
    "ae426082"
)


class FixtureRequestHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format_: str, *args: object) -> None:
        return  # keep test output quiet

    def do_GET(self) -> None:
        split = urlsplit(self.path)
        query = parse_qs(split.query)

        if split.path == "/redirect":
            target = query.get("to", [""])[0]
            self.send_response(302)
            self.send_header("Location", target)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if split.path == "/oversized":
            size = int(query.get("bytes", ["0"])[0])
            body = b"a" * size
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            self.wfile.write(body)
            return

        if split.path == "/slow":
            delay = float(query.get("seconds", ["0"])[0])
            time.sleep(delay)
            body = b"<html><body>slow</body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if split.path == "/api/echo":
            self._respond_json_ok()
            return

        if split.path == "/api/products":
            body = (
                b'{"products":[{"id":"fixture-1","name":"Fixture headphones",'
                b'"merchant":"Fixture shop","availability":"available",'
                b'"priceAmount":99,"currency":"USD"}]}'
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if split.path == "/api/accommodation":
            body = (
                b'{"products":[{"id":"room-1","name":"Deluxe Room",'
                b'"merchant":"Fixture Hotel","availability":"available",'
                b'"priceAmount":150,"currency":"USD"}]}'
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if split.path == "/api/flights":
            body = (
                b'{"flights":[{"id":"fl-1","origin":"SFO","destination":"JFK",'
                b'"priceAmount":250,"currency":"USD"}]}'
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if split.path == "/api/generic-records":
            body = b'{"items":[{"id":"rec-1","kind":"widget","value":42}]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if split.path == "/api/big":
            body = b'{"blob": "' + (b"a" * 300_000) + b'"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if split.path == "/api/binary":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(_TINY_PNG)))
            self.end_headers()
            self.wfile.write(_TINY_PNG)
            return

        file_path = (PAGES_DIR / split.path.lstrip("/")).resolve()
        if split.path == "/":
            file_path = PAGES_DIR / "index.html"
        if PAGES_DIR not in file_path.parents and file_path != PAGES_DIR:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not file_path.is_file():
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        split = urlsplit(self.path)
        # Drain the request body -- HTTP/1.1 keep-alive requires the whole
        # body to be read even though the response never reflects it.
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length:
            self.rfile.read(length)

        if split.path == "/api/echo":
            self._respond_json_ok()
            return

        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _respond_json_ok(self) -> None:
        body = b'{"ok": true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextmanager
def fixture_http_server() -> Iterator[int]:
    """Start the fixture server on an ephemeral loopback port; yield the port."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FixtureRequestHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
