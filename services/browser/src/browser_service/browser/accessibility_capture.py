"""Live CDP side of the Phase 2 accessibility capture (P02-F02 step 2).

Kept in the browser package rather than ``extraction`` so the extraction
pipeline stays pure and fixture-testable: this is the only place that
talks to a live tab, and everything it returns is plain Python that
``browser_service.extraction.accessibility`` reduces.

Both calls are plain CDP domain commands -- ``Accessibility.getFullAXTree``
and a pierced ``DOM.getDocument`` used solely to build the
``backendDOMNodeId -> tag name`` correlation map. No page-authored script is
ever evaluated.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from browser_service.extraction.accessibility import RawAxNode, raw_ax_node
from browser_service.page_observation.cdp import CdpNode, CdpSession, wrap_ax_nodes

#: Bounds the correlation walk so a hostile or pathological document cannot
#: turn one snapshot into an unbounded traversal.
MAX_CORRELATED_DOM_NODES = 30_000


@dataclass(frozen=True)
class AccessibilityCapture:
    """The raw, un-reduced pair of sources for one page observation."""

    ax_nodes: list[RawAxNode] = field(default_factory=list)
    dom_tag_by_backend_id: dict[int, str] = field(default_factory=dict)
    #: ``False`` when the accessibility domain was unavailable or failed;
    #: callers surface this as an explicit warning rather than pretending
    #: the page simply had no accessible structure.
    available: bool = True


def _collect_tags(node: CdpNode, tags: dict[int, str]) -> None:
    stack: list[CdpNode] = [node]
    while stack and len(tags) < MAX_CORRELATED_DOM_NODES:
        current = stack.pop()
        backend_id = getattr(current, "backend_node_id", None)
        if backend_id is not None and current.node_type == 1:
            tags[int(backend_id)] = (current.node_name or "").lower()
        for child in current.children or []:
            stack.append(child)
        for shadow_root in current.shadow_roots or []:
            stack.append(shadow_root)
        content_document = getattr(current, "content_document", None)
        if content_document is not None:
            stack.append(content_document)


async def capture_accessibility(session: CdpSession) -> AccessibilityCapture:
    """Fetches the full accessibility tree plus the DOM tags needed to
    correlate it. Never raises: an unavailable accessibility domain
    degrades to ``available=False`` so the surrounding extraction still
    produces a document."""
    try:
        ax_nodes = wrap_ax_nodes(await session.send("Accessibility.getFullAXTree"))
    except Exception:  # noqa: BLE001 -- accessibility capture is best-effort
        return AccessibilityCapture(available=False)

    tags: dict[int, str] = {}
    try:
        response = await session.send("DOM.getDocument", {"depth": -1, "pierce": True})
        document = CdpNode(response["root"])
    except Exception:  # noqa: BLE001 -- correlation is enrichment, not a hard requirement
        document = None
    if document is not None:
        _collect_tags(document, tags)

    return AccessibilityCapture(
        ax_nodes=[raw_ax_node(node) for node in ax_nodes],
        dom_tag_by_backend_id=tags,
        available=True,
    )


__all__ = ["AccessibilityCapture", "capture_accessibility"]
