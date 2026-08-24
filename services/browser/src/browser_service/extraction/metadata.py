"""Document metadata extraction from trustworthy structured HTML sources.

This module reads the *unmodified* parsed tree (before script/style/hidden
stripping) because JSON-LD publication dates live inside ``<script>``
elements that step 2 of the pipeline removes for content purposes.
Nothing here treats page text as instructions -- only a small, fixed set
of structured attributes/elements is consulted, and free text is never
mined for a guessed date.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from browser_service.extraction.normalize import normalize_text


@dataclass(frozen=True)
class HeadMetadata:
    title: str | None
    canonical_url: str | None
    language: str
    description: str | None
    published_time: str | None


def _text_or_none(tag: Tag | None) -> str | None:
    if tag is None:
        return None
    text = normalize_text(tag.get_text(separator=" ", strip=True))
    return text or None


def _meta_content(soup: BeautifulSoup, **attrs: str) -> str | None:
    # Passed as the dedicated `attrs` mapping (not **kwargs) because a
    # caller-supplied key of "name" would otherwise collide with find()'s
    # own positional `name` parameter (tag-name matching).
    tag = soup.find("meta", attrs=cast(dict[str, Any], attrs))
    if not isinstance(tag, Tag):
        return None
    content = tag.get("content")
    if not isinstance(content, str):
        return None
    normalized = normalize_text(content)
    return normalized or None


def _resolve_canonical(base_url: str, href: str) -> str | None:
    href = href.strip()
    if not href:
        return None
    resolved = urljoin(base_url, href)
    resolved_parts = urlparse(resolved)
    base_parts = urlparse(base_url)
    if resolved_parts.scheme not in ("http", "https"):
        return None
    if resolved_parts.netloc.lower() != base_parts.netloc.lower():
        # Not same-origin-ish/plausible relative to the page we actually
        # fetched -- prefer the known-good final URL instead.
        return None
    return resolved


def _find_published_time(soup: BeautifulSoup) -> str | None:
    for attrs in (
        {"property": "article:published_time"},
        {"name": "article:published_time"},
        {"property": "og:article:published_time"},
    ):
        value = _meta_content(soup, **attrs)
        if value:
            return value

    time_tag = soup.find("time")
    if isinstance(time_tag, Tag):
        datetime_attr = time_tag.get("datetime")
        if isinstance(datetime_attr, str) and datetime_attr.strip():
            return normalize_text(datetime_attr)

    for script in soup.find_all("script", type="application/ld+json"):
        raw = script.string
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        found = _find_date_published(payload)
        if found:
            return found

    return None


def _find_date_published(payload: object) -> str | None:
    candidates: list[object] = payload if isinstance(payload, list) else [payload]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        value = candidate.get("datePublished")
        if isinstance(value, str) and value.strip():
            return normalize_text(value)
        graph = candidate.get("@graph")
        if isinstance(graph, list):
            found = _find_date_published(graph)
            if found:
                return found
    return None


def extract_head_metadata(soup: BeautifulSoup, final_url: str) -> HeadMetadata:
    title = _text_or_none(soup.find("title"))

    canonical_url: str | None = None
    canonical_tag = soup.find("link", rel="canonical")
    if isinstance(canonical_tag, Tag):
        href = canonical_tag.get("href")
        if isinstance(href, str):
            canonical_url = _resolve_canonical(final_url, href)

    language = "und"
    html_tag = soup.find("html")
    if isinstance(html_tag, Tag):
        lang_attr = html_tag.get("lang")
        if isinstance(lang_attr, str) and lang_attr.strip():
            language = lang_attr.strip()

    description = _meta_content(soup, name="description")
    if description is None:
        description = _meta_content(soup, property="og:description")

    published_time = _find_published_time(soup)

    return HeadMetadata(
        title=title,
        canonical_url=canonical_url,
        language=language,
        description=description,
        published_time=published_time,
    )
