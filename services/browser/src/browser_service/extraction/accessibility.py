"""Bounded accessibility-tree capture and reduction (P02-F02 steps 2-3).

The raw tree comes from CDP ``Accessibility.getFullAXTree`` -- the same
call ``tests/ast_scraping_test.py`` demonstrates -- but that script's
``str(ax_tree)`` dump is a debugging artifact, never a contract. This
module turns the same source into the typed, bounded, JSON-serializable
:class:`~browser_service.extraction.models.AccessibilityNode` list the
rest of the pipeline (and Phase 3) consumes.

Two sources are correlated: the AX tree carries semantics (role, name,
description, state) while the pierced ``DOM.getDocument`` snapshot carries
tag names. They are joined on ``backendDOMNodeId``; an AX node with no DOM
counterpart is still kept (marked ``correlated=False``) rather than
silently dropped, because ignoring it would hide real page structure.

Nothing here is executable: no selector, backend id, script, entered form
value, or credential ever reaches the reduced output.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from browser_service.extraction.models import (
    AccessibilityNode,
    ExtractionLimits,
    ExtractionWarning,
    WarningCode,
)
from browser_service.extraction.normalize import normalize_text

MAX_AX_NAME_CHARS = 500
MAX_AX_DESCRIPTION_CHARS = 1_000
MAX_AX_VALUE_CHARS = 300
MAX_AX_ROLE_CHARS = 60
MAX_AX_STATES = 12

#: Only these ARIA/AX states materially explain a visible control. Anything
#: else the platform reports is dropped rather than forwarded.
AX_STATE_PROPERTIES = frozenset(
    {
        "checked",
        "current",
        "disabled",
        "expanded",
        "haspopup",
        "invalid",
        "level",
        "modal",
        "multiselectable",
        "pressed",
        "readonly",
        "required",
        "selected",
    }
)

#: Roles whose accessible *value* is whatever a user (or a prior autofill)
#: typed. Their value is never captured -- only the fact that the field
#: exists, via role/name.
EDITABLE_VALUE_ROLES = frozenset(
    {
        "combobox",
        "searchbox",
        "spinbutton",
        "textbox",
        "textarea",
        "password",
        "passwordtext",
    }
)

#: AX nodes that carry no meaning of their own once their subtree's text is
#: already in the content blocks.
STRUCTURAL_ONLY_ROLES = frozenset({"none", "presentation", "generic", "inlinetextbox"})


@dataclass(frozen=True)
class RawAxNode:
    """One CDP ``AXNode`` reduced to plain Python, so the reduction below
    stays pure and testable without a live browser."""

    ax_id: str
    role: str | None
    name: str | None
    description: str | None
    value: str | None
    properties: dict[str, Any] = field(default_factory=dict)
    ignored: bool = False
    backend_dom_node_id: int | None = None
    parent_id: str | None = None
    child_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class AccessibilityReduction:
    nodes: list[AccessibilityNode]
    warnings: list[ExtractionWarning]
    total_seen: int
    truncated: bool


def _scalar(value: Any) -> Any:
    """CDP wraps most fields in an ``AXValue``; unwrap one level of it."""
    if value is None:
        return None
    inner = getattr(value, "value", None)
    return value if inner is None else inner


def _text(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    normalized = normalize_text(str(value))
    return normalized[:limit] or None


def _property_name(prop: Any) -> str:
    name = getattr(prop, "name", prop)
    return str(getattr(name, "value", name)).lower()


def raw_ax_node(node: Any) -> RawAxNode:
    """Converts one CDP ``Accessibility.AXNode`` view into a
    :class:`RawAxNode`, so the reduction logic never depends on the CDP
    object model."""
    properties: dict[str, Any] = {}
    for prop in getattr(node, "properties", None) or []:
        name = _property_name(prop)
        if name in AX_STATE_PROPERTIES:
            properties[name] = _scalar(getattr(prop, "value", None))
    parent_id = getattr(node, "parent_id", None)
    child_ids = tuple(str(child) for child in (getattr(node, "child_ids", None) or []))
    backend = getattr(node, "backend_dom_node_id", None)
    return RawAxNode(
        ax_id=str(getattr(node, "node_id", "")),
        role=_scalar(getattr(node, "role", None)),
        name=_scalar(getattr(node, "name", None)),
        description=_scalar(getattr(node, "description", None)),
        value=_scalar(getattr(node, "value", None)),
        properties=properties,
        ignored=bool(getattr(node, "ignored", False)),
        backend_dom_node_id=int(backend) if backend is not None else None,
        parent_id=str(parent_id) if parent_id is not None else None,
        child_ids=child_ids,
    )


def _states(raw: RawAxNode) -> dict[str, bool | str]:
    states: dict[str, bool | str] = {}
    for name, value in sorted(raw.properties.items()):
        if len(states) >= MAX_AX_STATES:
            break
        if value is None:
            continue
        if isinstance(value, bool):
            states[name] = value
        else:
            text = _text(value, 60)
            if text is not None:
                states[name] = text
    return states


def reduce_ax_tree(
    raw_nodes: list[RawAxNode],
    dom_tag_by_backend_id: dict[int, str] | None = None,
    limits: ExtractionLimits | None = None,
) -> AccessibilityReduction:
    """Filters, bounds, and re-keys a raw AX tree into document-local nodes.

    Ignored nodes and purely structural roles are dropped; a dropped node's
    children are re-parented onto their nearest surviving ancestor so the
    remaining tree stays connected. Node ids are document-local (``ax-1``,
    ``ax-2``, ...) -- a raw ``AXNodeId`` is never exposed, since it is only
    meaningful against the live CDP session that produced it.
    """
    resolved_limits = limits if limits is not None else ExtractionLimits()
    tags = dom_tag_by_backend_id or {}
    by_ax_id = {raw.ax_id: raw for raw in raw_nodes}

    kept_id_by_ax_id: dict[str, str] = {}
    nodes: list[AccessibilityNode] = []
    total_seen = 0
    truncated = False

    def nearest_kept_parent(raw: RawAxNode) -> str | None:
        parent_ax_id = raw.parent_id
        seen: set[str] = set()
        while parent_ax_id is not None and parent_ax_id not in seen:
            seen.add(parent_ax_id)
            mapped = kept_id_by_ax_id.get(parent_ax_id)
            if mapped is not None:
                return mapped
            parent = by_ax_id.get(parent_ax_id)
            if parent is None:
                return None
            parent_ax_id = parent.parent_id
        return None

    for raw in raw_nodes:
        role = _text(raw.role, MAX_AX_ROLE_CHARS)
        if raw.ignored or role is None or role.lower() in STRUCTURAL_ONLY_ROLES:
            continue
        name = _text(raw.name, MAX_AX_NAME_CHARS)
        description = _text(raw.description, MAX_AX_DESCRIPTION_CHARS)
        states = _states(raw)
        value = (
            None
            if role.lower() in EDITABLE_VALUE_ROLES
            else _text(raw.value, MAX_AX_VALUE_CHARS)
        )
        if name is None and description is None and value is None and not states:
            # A structural wrapper with nothing of its own to say; its
            # descendants still carry the page's meaning.
            continue
        total_seen += 1
        if len(nodes) >= resolved_limits.max_accessibility_nodes:
            truncated = True
            continue
        node_id = f"ax-{len(nodes) + 1}"
        kept_id_by_ax_id[raw.ax_id] = node_id
        dom_tag = tags.get(raw.backend_dom_node_id) if raw.backend_dom_node_id is not None else None
        nodes.append(
            AccessibilityNode(
                node_id=node_id,
                parent_id=nearest_kept_parent(raw),
                role=role,
                name=name,
                description=description,
                value=value,
                states=states,
                dom_tag=dom_tag,
                correlated=dom_tag is not None,
            )
        )

    warnings: list[ExtractionWarning] = []
    if truncated:
        warnings.append(
            ExtractionWarning(
                code=WarningCode.ACCESSIBILITY_NODE_LIMIT_REACHED,
                message=(
                    "Stopped after the configured accessibility-node limit "
                    f"({resolved_limits.max_accessibility_nodes} of {total_seen} kept); "
                    "the remaining nodes were dropped."
                ),
            )
        )
    return AccessibilityReduction(
        nodes=nodes, warnings=warnings, total_seen=total_seen, truncated=truncated
    )


__all__ = [
    "AX_STATE_PROPERTIES",
    "AccessibilityReduction",
    "EDITABLE_VALUE_ROLES",
    "RawAxNode",
    "raw_ax_node",
    "reduce_ax_tree",
]
