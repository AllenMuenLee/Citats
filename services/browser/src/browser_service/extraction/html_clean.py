"""Stripping of disallowed elements and attribute/style-hidden content.

Scope note: this pipeline receives an already-serialized HTML string (a
stand-in for ``page.get_content()`` from the browser-automation layer) and
has no access to a live CSS cascade or computed style. "Hidden" is
therefore detected only via the ``hidden`` attribute, ``aria-hidden``, and
a small set of inline-style declarations -- true cross-stylesheet
computed-style resolution is out of scope by design, not an oversight.
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup, Tag

from browser_service.extraction.models import ExtractionWarning, WarningCode
from browser_service.extraction.risk_scan import RiskCategory, scan_text

# Elements removed unconditionally, regardless of visibility. ``form`` and
# its descendants (inputs, buttons, textareas, selects, ...) are removed as
# a whole subtree, which also satisfies "never re-introduce form field
# values" for step 4 since nothing under a form ever reaches later stages.
_ALWAYS_STRIP_TAGS = frozenset({"script", "style", "form", "noscript", "template"})

_DISPLAY_NONE_RE = re.compile(r"display\s*:\s*none", re.IGNORECASE)
_VISIBILITY_HIDDEN_RE = re.compile(r"visibility\s*:\s*hidden", re.IGNORECASE)


def is_hidden(tag: Tag) -> bool:
    if tag.has_attr("hidden"):
        return True
    aria_hidden = tag.get("aria-hidden")
    if isinstance(aria_hidden, str) and aria_hidden.strip().lower() == "true":
        return True
    style = tag.get("style")
    return isinstance(style, str) and bool(
        _DISPLAY_NONE_RE.search(style) or _VISIBILITY_HIDDEN_RE.search(style)
    )


def clean_tree(soup: BeautifulSoup) -> list[ExtractionWarning]:
    """Mutate ``soup`` in place, stripping disallowed and hidden elements.

    Returns warnings describing what was removed. Text inside removed
    *hidden* elements is risk-scanned before it is discarded -- callers
    must never act on it, but it must not vanish without a trace either.
    """
    warnings: list[ExtractionWarning] = []

    for tag in list(soup.find_all(_ALWAYS_STRIP_TAGS)):
        if tag.parent is None:
            continue
        tag.decompose()

    # Document order (pre-order) so an ancestor is visited, and possibly
    # decomposed, before its descendants -- descendants of an already
    # decomposed ancestor are skipped via the `tag.parent is None` guard,
    # keeping this pass deterministic and non-redundant.
    for tag in list(soup.find_all(True)):
        if tag.parent is None:
            continue
        if not is_hidden(tag):
            continue

        hidden_text = tag.get_text(separator=" ", strip=True)
        for hit in scan_text(hidden_text):
            if hit.category is RiskCategory.CREDENTIAL_LIKE:
                warnings.append(
                    ExtractionWarning(
                        code=WarningCode.CREDENTIAL_LIKE_CONTENT,
                        message=(
                            "Hidden element contained credential-shaped text; "
                            "it was stripped and never surfaced in the extracted content."
                        ),
                    )
                )
            elif hit.category is RiskCategory.PROMPT_INJECTION:
                warnings.append(
                    ExtractionWarning(
                        code=WarningCode.PROMPT_INJECTION_SUSPECTED,
                        message=(
                            "Hidden element contained text resembling an instruction-override "
                            "attempt; it was stripped and must not be treated as an instruction."
                        ),
                    )
                )

        warnings.append(
            ExtractionWarning(
                code=WarningCode.HIDDEN_CONTENT_STRIPPED,
                message="Removed an element hidden via attribute or inline style heuristics.",
            )
        )
        tag.decompose()

    return warnings


def select_content_root(soup: BeautifulSoup) -> tuple[Tag, bool]:
    """Deterministically select the main-content root.

    Tries semantic containers in a fixed priority order; falls back to
    ``<body>`` (or the whole soup if there is no ``<body>``) when none are
    found. Returns ``(root, used_fallback)``.
    """
    main = soup.find("main")
    if isinstance(main, Tag):
        return main, False

    article = soup.find("article")
    if isinstance(article, Tag):
        return article, False

    role_main = soup.find(True, role="main")
    if isinstance(role_main, Tag):
        return role_main, False

    role_article = soup.find(True, role="article")
    if isinstance(role_article, Tag):
        return role_article, False

    body = soup.find("body")
    if isinstance(body, Tag):
        return body, True

    # No <body> at all (e.g. a bare fragment) -- fall back to the whole
    # document. ``BeautifulSoup`` is itself a ``Tag`` subclass.
    return soup, True
