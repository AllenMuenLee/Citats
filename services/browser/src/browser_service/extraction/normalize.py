"""Whitespace and Unicode normalization helpers."""

from __future__ import annotations

import re
import unicodedata

_WHITESPACE_RE = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """NFC-normalize Unicode and collapse redundant whitespace to single spaces."""
    normalized = unicodedata.normalize("NFC", text)
    collapsed = _WHITESPACE_RE.sub(" ", normalized)
    return collapsed.strip()
