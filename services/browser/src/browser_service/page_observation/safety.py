"""Content safety, privacy, and URL/media policy (P03-F03).

Every observed string is untrusted data (mission item throughout): this
module runs the same credential/injection scanner the extraction pipeline
already uses (`browser_service.extraction.risk_scan`) before a string ever
enters the canonical graph, classifies observed URLs against a bounded
safe-scheme policy, and provides the `is_hidden` fallback used when a node
has no accessibility-tree counterpart to lean on.
"""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import urljoin, urlparse, urlsplit, urlunsplit

from browser_service.extraction.normalize import normalize_text
from browser_service.extraction.risk_scan import RiskCategory, scan_text

UNSAFE_URL_SCHEMES = frozenset({"javascript", "data", "blob", "file", "vbscript"})
SAFE_URL_SCHEMES = frozenset({"http", "https"})

_DISPLAY_NONE_RE = re.compile(r"display\s*:\s*none", re.IGNORECASE)
_VISIBILITY_HIDDEN_RE = re.compile(r"visibility\s*:\s*hidden", re.IGNORECASE)
_OPACITY_ZERO_RE = re.compile(r"opacity\s*:\s*(?:0+(?:\.0*)?|\.0+)\s*(?:;|$)", re.IGNORECASE)
_CLIPPED_RE = re.compile(
    r"(?:clip\s*:\s*rect\(\s*0(?:px)?(?:[\s,]+0(?:px)?){3}\s*\)"
    r"|clip-path\s*:\s*inset\(\s*(?:50|100)%)",
    re.IGNORECASE,
)
_OFFSCREEN_RE = re.compile(
    r"(?:left|right|top|bottom)\s*:\s*-\s*(?:[1-9]\d{2,})(?:px|rem|em|vw|vh)",
    re.IGNORECASE,
)
_DOWNLOAD_SUFFIXES = frozenset(
    {".7z", ".apk", ".bat", ".bin", ".cmd", ".dmg", ".exe", ".iso", ".msi", ".pkg", ".rar", ".zip"}
)
_PRIVATE_HOST_SUFFIXES = (".home", ".internal", ".lan", ".local", ".localhost")
_PRIVATE_HOSTS = frozenset({"localhost", "metadata.google.internal"})


def attribute_hidden(attributes: dict[str, str]) -> bool:
    """Attribute/inline-style hidden heuristic, used only when a node has
    no accessibility-tree counterpart (see `graph.py`) -- when one exists,
    its own `ignored` state (computed by Chromium itself, cascade and all)
    is authoritative instead."""
    if "hidden" in attributes:
        return True
    aria_hidden = attributes.get("aria-hidden", "").strip().lower()
    if aria_hidden == "true":
        return True
    style = attributes.get("style", "")
    return bool(
        _DISPLAY_NONE_RE.search(style)
        or _VISIBILITY_HIDDEN_RE.search(style)
        or _OPACITY_ZERO_RE.search(style)
        or _CLIPPED_RE.search(style)
        or _OFFSCREEN_RE.search(style)
    )


def sanitize_visible_text(raw: str | None, *, max_length: int) -> tuple[str | None, bool]:
    """Normalizes and risk-scans a visible string before it may enter the
    graph. Returns `(text_or_None, credential_like_hit)` -- a
    credential-shaped match is never surfaced (redacted to `None`); a
    prompt-injection-shaped match on genuinely visible content is left in
    place (it is real page content, already covered by the envelope's
    `untrusted: true`), matching this project's existing visible-content
    handling in `extraction.html_clean`.
    """
    if not raw:
        return None, False
    text = normalize_text(raw)
    if not text:
        return None, False
    hits = scan_text(text)
    if any(hit.category is RiskCategory.CREDENTIAL_LIKE for hit in hits):
        return None, True
    return text[:max_length], False


def hidden_text_has_injection(raw: str | None) -> bool:
    if not raw:
        return False
    return any(hit.category is RiskCategory.PROMPT_INJECTION for hit in scan_text(raw))


def classify_url(raw: str | None, *, base_url: str) -> tuple[str | None, str | None]:
    """Resolves `raw` against `base_url` and classifies it. Returns
    `(safe_absolute_url_or_None, block_reason_or_None)`. Blocks
    non-http(s) schemes, credential-bearing URLs, and unresolvable values;
    never fetches the URL -- this phase only records provenance, it never
    requests media/sub-resources itself.
    """
    if not raw or not raw.strip():
        return None, None
    value = raw.strip()
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        return None, "unparseable_url"
    try:
        resolved = urljoin(base_url, value)
        parsed = urlsplit(resolved)
    except ValueError:
        return None, "unparseable_url"
    scheme = parsed.scheme.lower()
    if scheme in UNSAFE_URL_SCHEMES:
        return None, "unsafe_scheme"
    if scheme not in SAFE_URL_SCHEMES:
        return None, "unsupported_scheme"
    if parsed.username is not None or parsed.password is not None:
        return None, "credentials_in_url"
    try:
        hostname = parsed.hostname
        _port = parsed.port
    except ValueError:
        return None, "unparseable_url"
    if not hostname:
        return None, "missing_hostname"
    normalized_host = hostname.rstrip(".").lower()
    if normalized_host in _PRIVATE_HOSTS or normalized_host.endswith(_PRIVATE_HOST_SUFFIXES):
        return None, "private_destination"
    try:
        address = ipaddress.ip_address(normalized_host.split("%", 1)[0])
    except ValueError:
        address = None
    if address is not None:
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            address = address.ipv4_mapped
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            return None, "private_destination"
    path_lower = parsed.path.lower()
    if any(path_lower.endswith(suffix) for suffix in _DOWNLOAD_SUFFIXES):
        return None, "download_url"
    sanitized = urlunsplit((scheme, parsed.netloc, parsed.path or "/", "", ""))
    if len(sanitized) > 2048:
        return None, "url_too_long"
    return sanitized, None


def destination_class(url: str | None, *, page_origin: str, page_url: str) -> str:
    """Closed classification for a link/navigation destination (mission
    item 7). Never itself a safety gate -- `classify_url` already blocked
    anything unsafe before this is called."""
    if url is None:
        return "unsafe"
    lowered = url.lower()
    if lowered.startswith("mailto:"):
        return "mailto"
    if lowered.startswith("tel:"):
        return "tel"
    parsed = urlparse(url)
    if f"{parsed.scheme}://{parsed.netloc}" == page_origin:
        page_parsed = urlparse(page_url)
        if parsed.path == page_parsed.path and parsed.netloc == page_parsed.netloc:
            return "same_page"
        return "same_origin"
    return "external_origin"


SENSITIVE_FIELD_ROLES = frozenset({"password", "hidden", "file"})


def is_sensitive_field_role(role: str) -> bool:
    return role.strip().lower() in SENSITIVE_FIELD_ROLES


__all__ = [
    "SAFE_URL_SCHEMES",
    "UNSAFE_URL_SCHEMES",
    "attribute_hidden",
    "classify_url",
    "destination_class",
    "hidden_text_has_injection",
    "is_sensitive_field_role",
    "sanitize_visible_text",
]
