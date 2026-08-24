"""Anchor and image extraction with absolute URL resolution.

``data:`` and other binary/inline URL schemes are excluded entirely from
the output per the pipeline's scope contract -- they are simply skipped,
never included as an "omitted" placeholder.
"""

from __future__ import annotations

from urllib.parse import urljoin, urlparse

from bs4 import Tag

from browser_service.extraction.models import Anchor, ImageRef
from browser_service.extraction.normalize import normalize_text

_EXCLUDED_SCHEMES = frozenset({"data", "blob"})


def _resolve(base_url: str, raw: str) -> str | None:
    raw = raw.strip()
    if not raw:
        return None
    resolved = urljoin(base_url, raw)
    scheme = urlparse(resolved).scheme.lower()
    if scheme in _EXCLUDED_SCHEMES:
        return None
    return resolved


def extract_anchors(root: Tag, base_url: str) -> list[Anchor]:
    anchors: list[Anchor] = []
    for tag in root.find_all("a"):
        href = tag.get("href")
        if not isinstance(href, str):
            continue
        resolved = _resolve(base_url, href)
        if resolved is None:
            continue
        text = normalize_text(tag.get_text(separator=" ", strip=True))
        anchors.append(Anchor(text=text, url=resolved))
    return anchors


def extract_images(root: Tag, base_url: str) -> list[ImageRef]:
    images: list[ImageRef] = []
    for tag in root.find_all("img"):
        src = tag.get("src")
        if not isinstance(src, str):
            continue
        resolved = _resolve(base_url, src)
        if resolved is None:
            continue
        alt = tag.get("alt")
        alt_text = normalize_text(alt) if isinstance(alt, str) and alt.strip() else None
        images.append(ImageRef(alt=alt_text, url=resolved))
    return images
