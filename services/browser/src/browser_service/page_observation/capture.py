"""Bounded CDP DOM + Accessibility capture (P03-F01 steps 1, 3, 4).

Uses only the CDP DOM and Accessibility domains -- never page-authored
script -- to obtain the post-render document, same-origin/same-process
child frames, and open shadow roots in one pierced snapshot, plus the
accessibility tree correlated by `backendDOMNodeId`. Cross-origin frames
and closed shadow roots are never bypassed: CDP simply does not inline
their content into a pierced `DOM.getDocument` response, so they are
detected structurally (an `iframe`/host node with no corresponding
content) rather than probed.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from nodriver.cdp import accessibility as cdp_ax
from nodriver.cdp import dom as cdp_dom
from nodriver.core.tab import Tab  # type: ignore[import-untyped]

DEFAULT_MAX_RAW_NODES = 20_000
DEFAULT_MAX_DEPTH = 60
DEFAULT_CAPTURE_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class CaptureLimits:
    max_raw_nodes: int = DEFAULT_MAX_RAW_NODES
    max_depth: int = DEFAULT_MAX_DEPTH
    timeout_seconds: float = DEFAULT_CAPTURE_TIMEOUT_SECONDS


@dataclass
class RawNode:
    """One DOM node from a pierced `DOM.getDocument` snapshot, reduced to
    exactly what the rest of the pipeline needs. `node_type` follows the
    DOM `Node.nodeType` numbering (1 = element, 3 = text, 11 = document
    fragment / shadow root)."""

    backend_node_id: int
    node_type: int
    tag: str
    attributes: dict[str, str]
    text: str | None
    children: list[RawNode] = field(default_factory=list)
    is_shadow_root: bool = False
    is_frame_owner: bool = False
    frame_boundary_reason: str | None = None
    origin_hint: str | None = None
    inaccessible_boundary_reason: str | None = None


@dataclass(frozen=True)
class AxState:
    role: str | None
    name: str | None
    description: str | None
    ignored: bool
    properties: dict[str, object]


@dataclass(frozen=True)
class CaptureResult:
    root: RawNode
    ax_by_backend_id: dict[int, AxState]
    node_count: int
    truncated_by_node_limit: bool
    truncated_by_depth: bool
    timed_out: bool
    duplicate_or_cycle_count: int


def _attr_dict(flat: list[str] | None) -> dict[str, str]:
    if not flat:
        return {}
    return {flat[i]: flat[i + 1] for i in range(0, len(flat) - 1, 2)}


def _reduce_node(
    node: cdp_dom.Node,
    *,
    depth: int,
    limits: CaptureLimits,
    counter: list[int],
    deadline: float,
    truncation: dict[str, bool | int],
    visited: set[int],
) -> RawNode:
    tag = (node.node_name or "").lower()
    text = node.node_value if node.node_type == 3 else None
    raw = RawNode(
        backend_node_id=node.backend_node_id,
        node_type=node.node_type,
        tag=tag,
        attributes=_attr_dict(node.attributes),
        text=text,
    )

    backend_id = int(node.backend_node_id)
    if backend_id in visited:
        truncation["duplicates"] = truncation.get("duplicates", 0) + 1
        raw.inaccessible_boundary_reason = "cycle_or_duplicate_reference"
        return raw
    visited.add(backend_id)
    counter[0] += 1

    if depth >= limits.max_depth:
        truncation["depth"] = True
        return raw
    if counter[0] >= limits.max_raw_nodes:
        truncation["nodes"] = True
        return raw
    if time.monotonic() >= deadline:
        truncation["timeout"] = True
        return raw

    children: list[cdp_dom.Node] = list(node.children or [])

    if tag == "iframe":
        raw.is_frame_owner = True
        if node.content_document is not None:
            children = [node.content_document]
        else:
            raw.frame_boundary_reason = "cross_origin_frame"
            raw.origin_hint = raw.attributes.get("src")

    for shadow_root in node.shadow_roots or []:
        shadow_raw = _reduce_node(
            shadow_root,
            depth=depth + 1,
            limits=limits,
            counter=counter,
            deadline=deadline,
            truncation=truncation,
            visited=visited,
        )
        shadow_raw.is_shadow_root = True
        raw.children.append(shadow_raw)

    if tag in {"object", "embed"}:
        raw.inaccessible_boundary_reason = "plugin_or_embedded_content"

    for child in children:
        if counter[0] >= limits.max_raw_nodes:
            truncation["nodes"] = True
            break
        if time.monotonic() >= deadline:
            truncation["timeout"] = True
            break
        raw.children.append(
            _reduce_node(
                child,
                depth=depth + 1,
                limits=limits,
                counter=counter,
                deadline=deadline,
                truncation=truncation,
                visited=visited,
            )
        )

    return raw


_STATE_PROPERTY_NAMES = frozenset(
    {
        "expanded",
        "pressed",
        "checked",
        "selected",
        "current",
        "busy",
        "invalid",
        "required",
        "disabled",
        "readonly",
        "focusable",
        "modal",
        "hidden",
    }
)


def _ax_value_scalar(value: cdp_ax.AXValue | None) -> object:
    if value is None:
        return None
    return value.value


def _parse_ax_node(node: cdp_ax.AXNode) -> AxState | None:
    if node.backend_dom_node_id is None:
        return None
    properties: dict[str, object] = {}
    for prop in node.properties or []:
        property_name = str(prop.name.value) if hasattr(prop.name, "value") else str(prop.name)
        if property_name.lower() in _STATE_PROPERTY_NAMES:
            properties[property_name.lower()] = _ax_value_scalar(prop.value)
    ax_role = _ax_value_scalar(node.role)
    name = _ax_value_scalar(node.name)
    description = _ax_value_scalar(node.description)
    return AxState(
        role=str(ax_role) if ax_role is not None else None,
        name=str(name) if name else None,
        description=str(description) if description else None,
        ignored=bool(node.ignored),
        properties=properties,
    )


async def capture_page(page: Tab, limits: CaptureLimits | None = None) -> CaptureResult:
    """Fetches one pierced DOM snapshot plus the accessibility tree,
    reduces the DOM snapshot into bounded `RawNode`s (depth/node/time
    limited, per P03-F01 step 3), and indexes accessibility state by
    `backendDOMNodeId` (P03-F01 step 4). Never touches page-authored
    script; both fetches are plain CDP domain commands.
    """
    cfg = limits if limits is not None else CaptureLimits()
    deadline = time.monotonic() + cfg.timeout_seconds

    document = await page.send(cdp_dom.get_document(depth=-1, pierce=True))
    try:
        ax_nodes = await page.send(cdp_ax.get_full_ax_tree())
    except Exception:  # noqa: BLE001 -- accessibility tree is best-effort enrichment
        ax_nodes = []

    ax_by_backend_id: dict[int, AxState] = {}
    for ax_node in ax_nodes:
        parsed = _parse_ax_node(ax_node)
        if parsed is not None and ax_node.backend_dom_node_id is not None:
            ax_by_backend_id[int(ax_node.backend_dom_node_id)] = parsed

    counter = [0]
    truncation: dict[str, bool | int] = {}
    root = _reduce_node(
        document,
        depth=0,
        limits=cfg,
        counter=counter,
        deadline=deadline,
        truncation=truncation,
        visited=set(),
    )

    return CaptureResult(
        root=root,
        ax_by_backend_id=ax_by_backend_id,
        node_count=counter[0],
        truncated_by_node_limit=bool(truncation.get("nodes", False)),
        truncated_by_depth=bool(truncation.get("depth", False)),
        timed_out=bool(truncation.get("timeout", False)),
        duplicate_or_cycle_count=int(truncation.get("duplicates", 0)),
    )


__all__ = [
    "AxState",
    "CaptureLimits",
    "CaptureResult",
    "RawNode",
    "capture_page",
]
