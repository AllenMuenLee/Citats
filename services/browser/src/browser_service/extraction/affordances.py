"""Bounded, descriptive-only extraction of visible interactive affordances.

An affordance describes what an interactive element on the page *is* --
its semantic role, visible label, safe (``http``/``https``) destination
when one exists, and disabled state -- never how to interact with it. No
selector, DOM path, script, or form field value is ever captured, so
nothing this module produces can be replayed to actually click, fill, or
submit anything; that capability does not exist anywhere in this phase.

Links and buttons are read from the same already-cleaned ``root`` that
``content_blocks``/``links`` extract from, so hidden-element stripping
(``html_clean.clean_tree``) already applies to them for free. Forms are a
different story: ``clean_tree`` removes every ``<form>`` subtree
unconditionally (see that module's docstring) before this pipeline ever
reaches ``root``, since form fields must never be reconstructed from
extracted content. A form's *purpose* is therefore read from a second,
still-unmutated parse of the same document (``pipeline.py`` already keeps
one around for head-metadata extraction) -- summarized as one affordance
per form, never its individual fields -- with this module doing its own
hidden-ancestor check since that tree was never run through ``clean_tree``.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from urllib.parse import urlparse

from bs4 import Tag

from browser_service.extraction.html_clean import is_hidden
from browser_service.extraction.links import resolve_url
from browser_service.extraction.models import Affordance, AffordanceRole
from browser_service.extraction.normalize import normalize_text

MAX_AFFORDANCES = 100
MAX_LABEL_CHARS = 200

_HEADING_TAG_NAMES = ("h1", "h2", "h3", "h4", "h5", "h6")
_SUBMIT_LIKE_INPUT_TYPES = re.compile(r"^(submit|button)$", re.IGNORECASE)
_SAFE_DESTINATION_SCHEMES = frozenset({"http", "https"})

# (role, label, destination, disabled) -- the same four fields Affordance
# carries, kept as a plain tuple until an opaque ID is assigned.
_Candidate = tuple[AffordanceRole, str, str | None, bool]


def _is_disabled(tag: Tag) -> bool:
    if tag.has_attr("disabled"):
        return True
    aria_disabled = tag.get("aria-disabled")
    return isinstance(aria_disabled, str) and aria_disabled.strip().lower() == "true"


def _visible_label(tag: Tag) -> str:
    text = normalize_text(tag.get_text(separator=" ", strip=True))
    if not text:
        aria_label = tag.get("aria-label")
        text = normalize_text(aria_label) if isinstance(aria_label, str) else ""
    return text[:MAX_LABEL_CHARS]


def _safe_destination(tag: Tag, base_url: str) -> str | None:
    href = tag.get("href")
    if not isinstance(href, str):
        return None
    resolved = resolve_url(base_url, href)
    if resolved is None:
        return None
    if urlparse(resolved).scheme.lower() not in _SAFE_DESTINATION_SCHEMES:
        return None
    return resolved


def _walk_link_and_button_candidates(root: Tag) -> Iterator[Tag]:
    """Document-order walk of ``root`` (already cleaned -- forms and
    hidden elements are already gone) for native/ARIA link and button
    elements."""
    for tag in root.find_all(True):
        if tag.name in ("a", "button"):
            yield tag
            continue
        role = tag.get("role")
        if isinstance(role, str) and role.strip().lower() in ("button", "link"):
            yield tag


def _link_or_button_affordance(tag: Tag, base_url: str) -> _Candidate | None:
    label = _visible_label(tag)
    if not label:
        return None
    disabled = _is_disabled(tag)

    if tag.name == "a":
        return AffordanceRole.LINK, label, _safe_destination(tag, base_url), disabled

    if tag.name == "button":
        return AffordanceRole.BUTTON, label, None, disabled

    role = tag.get("role")
    role_value = role.strip().lower() if isinstance(role, str) else ""
    if role_value == "button":
        return AffordanceRole.BUTTON, label, None, disabled
    if role_value == "link":
        return AffordanceRole.LINK, label, _safe_destination(tag, base_url), disabled
    return None  # pragma: no cover -- callers already filter to link/button roles


def _is_visible_within(tag: Tag, boundary: Tag) -> bool:
    """Ancestor-inclusive hidden check up to (and including) ``boundary``.

    Unlike ``root``-scoped link/button extraction, forms are read from an
    unmutated tree that never went through ``clean_tree``'s cascading
    decompose, so a hidden ancestor must be checked explicitly here.
    """
    node: Tag | None = tag
    while node is not None:
        if is_hidden(node):
            return False
        if node is boundary:
            return True
        node = node.parent if isinstance(node.parent, Tag) else None
    return True


def _form_label(form: Tag) -> str:
    aria_label = form.get("aria-label")
    if isinstance(aria_label, str) and normalize_text(aria_label):
        return normalize_text(aria_label)[:MAX_LABEL_CHARS]

    labelledby = form.get("aria-labelledby")
    if isinstance(labelledby, str) and labelledby.strip():
        referent = form.find(id=labelledby.strip().split(" ")[0])
        if isinstance(referent, Tag):
            text = normalize_text(referent.get_text(separator=" ", strip=True))
            if text:
                return text[:MAX_LABEL_CHARS]

    legend = form.find("legend")
    if isinstance(legend, Tag):
        text = normalize_text(legend.get_text(separator=" ", strip=True))
        if text:
            return text[:MAX_LABEL_CHARS]

    heading = form.find(_HEADING_TAG_NAMES)
    if isinstance(heading, Tag):
        text = normalize_text(heading.get_text(separator=" ", strip=True))
        if text:
            return text[:MAX_LABEL_CHARS]

    submit = form.find("button")
    if not isinstance(submit, Tag):
        submit = form.find("input", attrs={"type": _SUBMIT_LIKE_INPUT_TYPES})
    if isinstance(submit, Tag):
        text = ""
        if submit.name == "button":
            text = normalize_text(submit.get_text(separator=" ", strip=True))
        if not text:
            value = submit.get("value")
            text = normalize_text(value) if isinstance(value, str) else ""
        if text:
            return text[:MAX_LABEL_CHARS]

    return "Form"


def _form_affordances(pre_clean_root: Tag) -> Iterator[_Candidate]:
    for form in pre_clean_root.find_all("form"):
        if not _is_visible_within(form, pre_clean_root):
            continue
        yield AffordanceRole.FORM, _form_label(form), None, False


def extract_affordances(
    root: Tag, pre_clean_root: Tag, base_url: str
) -> tuple[list[Affordance], bool]:
    """Return bounded, visible interactive affordances plus whether the
    result was truncated.

    ``root`` is the already-cleaned content root (as used for
    blocks/anchors/images); ``pre_clean_root`` is the equivalent region
    from an unmutated parse of the same HTML, used only to summarize form
    purposes before ``clean_tree`` would have stripped them.
    """
    candidates: list[_Candidate] = []
    for tag in _walk_link_and_button_candidates(root):
        parsed = _link_or_button_affordance(tag, base_url)
        if parsed is not None:
            candidates.append(parsed)
    candidates.extend(_form_affordances(pre_clean_root))

    truncated = len(candidates) > MAX_AFFORDANCES
    affordances = [
        Affordance(
            affordance_id=f"affordance-{index}",
            role=role,
            label=label,
            destination=destination,
            disabled=disabled,
        )
        for index, (role, label, destination, disabled) in enumerate(candidates[:MAX_AFFORDANCES])
    ]
    return affordances, truncated


__all__ = ["MAX_AFFORDANCES", "extract_affordances"]
