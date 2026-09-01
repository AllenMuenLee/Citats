"""Serializes the *bounded observed DOM* back into HTML (P03-R03 steps 1-2).

`browser.explore_website` used to build two independent whole-page
representations for one exploration: a full `page.get_content()` HTML
serialization *and* a full pierced `DOM.getDocument`. Both were unbounded,
either could stall a large client-rendered site, and the HTML one was on
the critical path -- a successful bounded observation could not be returned
unless serialization of the entire rendered document completed first.

The observation already contains everything the Phase 2 extractor needs, so
this module renders the bounded `RawNode` tree the capture produced back
into HTML and feeds *that* to the existing extraction pipeline. Nothing new
is fetched, the extractor keeps its single well-tested entry point, and the
resulting evidence is by construction derived only from content the
observation actually retained -- a chunk can never quote text that was
truncated away, because the truncated text was never serialized.

The output is untrusted page content in the same way its input was. It is
parsed by the extractor and never executed, and this module never evaluates
page-authored script.
"""

from __future__ import annotations

from dataclasses import dataclass
from html import escape

from browser_service.page_observation.capture import RawNode

DEFAULT_MAX_HTML_CHARS = 4_000_000
DEFAULT_MAX_ATTRIBUTES_PER_ELEMENT = 40
DEFAULT_MAX_ATTRIBUTE_VALUE_CHARS = 4_000

#: Elements with no closing tag in the HTML serialization.
_VOID_ELEMENTS = frozenset(
    {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    }
)

#: Elements whose text content is raw (never entity-decoded by the parser).
#: Escaping their bodies would corrupt the JSON-LD that head-metadata
#: extraction reads out of `<script type="application/ld+json">`.
_RAW_TEXT_ELEMENTS = frozenset({"script", "style"})

#: Attributes never re-emitted. Event handlers are page-authored script by
#: another name, and `style` is high-volume noise the extractor ignores.
_DROPPED_ATTRIBUTE_PREFIXES = ("on",)
_DROPPED_ATTRIBUTES = frozenset({"style"})


@dataclass(frozen=True)
class RenderedObservation:
    html: str
    element_count: int
    truncated: bool


def _safe_attributes(node: RawNode) -> str:
    parts: list[str] = []
    for index, (name, value) in enumerate(node.attributes.items()):
        if index >= DEFAULT_MAX_ATTRIBUTES_PER_ELEMENT:
            break
        lowered = name.lower()
        if lowered in _DROPPED_ATTRIBUTES or lowered.startswith(_DROPPED_ATTRIBUTE_PREFIXES):
            continue
        if not lowered or any(char in lowered for char in " \t\n\r\"'/>="):
            continue
        parts.append(f'{lowered}="{escape(value[:DEFAULT_MAX_ATTRIBUTE_VALUE_CHARS], quote=True)}"')
    return ("" if not parts else " " + " ".join(parts))


class _Writer:
    def __init__(self, max_chars: int) -> None:
        self._parts: list[str] = []
        self._length = 0
        self._max_chars = max_chars
        self.truncated = False
        self.element_count = 0

    @property
    def full(self) -> bool:
        return self._length >= self._max_chars

    def write(self, text: str) -> None:
        if self.full:
            self.truncated = True
            return
        remaining = self._max_chars - self._length
        if len(text) > remaining:
            text = text[:remaining]
            self.truncated = True
        self._parts.append(text)
        self._length += len(text)

    def result(self) -> str:
        return "".join(self._parts)


def _render(node: RawNode, writer: _Writer) -> None:
    if writer.full:
        writer.truncated = True
        return

    # Text.
    if node.node_type == 3:
        if node.text:
            writer.write(escape(node.text, quote=False))
        return

    # Document, document fragment, and shadow root: content only, no wrapper
    # element of their own.
    if node.node_type in (9, 11) or not node.tag or node.tag.startswith("#"):
        for child in node.children:
            _render(child, writer)
        return

    if node.node_type != 1:
        return

    tag = node.tag
    writer.element_count += 1

    # A same-origin frame whose document CDP inlined. Rendered as a plain
    # section so its text participates in extraction; an `<iframe>` body is
    # not parsed as markup by HTML parsers, so keeping the original tag here
    # would silently discard everything inside it.
    if node.is_frame_owner and node.children:
        writer.write(f'<section data-observed-frame="1"{_safe_attributes(node)}>')
        for child in node.children:
            _render(child, writer)
        writer.write("</section>")
        return

    writer.write(f"<{tag}{_safe_attributes(node)}>")
    if tag in _VOID_ELEMENTS:
        return

    if tag in _RAW_TEXT_ELEMENTS:
        for child in node.children:
            if child.node_type == 3 and child.text:
                # Raw, but never able to close its own element early.
                writer.write(child.text.replace("</", "<\\/"))
        writer.write(f"</{tag}>")
        return

    for child in node.children:
        _render(child, writer)
    writer.write(f"</{tag}>")


def render_observed_html(
    root: RawNode, *, max_chars: int = DEFAULT_MAX_HTML_CHARS
) -> RenderedObservation:
    """Renders the bounded observed DOM as HTML for the extraction pipeline.

    The result is bounded by `max_chars` on top of every bound the capture
    already applied, so a pathological page cannot turn a bounded
    observation into an unbounded string.
    """
    writer = _Writer(max_chars)
    _render(root, writer)
    return RenderedObservation(
        html=writer.result(), element_count=writer.element_count, truncated=writer.truncated
    )


__all__ = [
    "DEFAULT_MAX_HTML_CHARS",
    "RenderedObservation",
    "render_observed_html",
]
