"""Deterministic, descriptive-only capability classification for Phase 3."""

from __future__ import annotations

from typing import cast
from urllib.parse import urlsplit

from browser_service.page_observation.handles import HandleMinter

_EMPTY_STATE = {
    "expanded": None,
    "pressed": None,
    "checked": None,
    "selected": None,
    "current": None,
    "busy": False,
    "invalid": False,
    "required": False,
    "disabled": False,
    "readOnly": False,
    "focusable": False,
}


def _origin(destination: object) -> str | None:
    if not isinstance(destination, str):
        return None
    parsed = urlsplit(destination)
    return f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme in {"http", "https"} else None


def classify_capabilities(
    nodes: list[dict[str, object]], relationships: list[dict[str, object]]
) -> tuple[list[dict[str, object]], dict[str, object]]:
    """Classify trusted node kinds/roles only; labels never lower risk.

    Phase 3's public default is observation-only, so the coverage report
    always records zero safely explored controls.
    """
    minter = HandleMinter("cap")
    parent_by_child = {
        str(edge["to"]): str(edge["from"])
        for edge in relationships
        if edge.get("kind") == "parent_child"
    }
    capabilities: list[dict[str, object]] = []
    prohibited = 0
    unknown = 0
    inaccessible = sum(1 for node in nodes if node.get("kind") == "embedded_boundary")

    for node in nodes:
        kind = node.get("kind")
        if kind not in {"link", "control", "field"}:
            continue
        handle = str(node["handle"])
        role = str(node.get("role") or "unknown")
        state = dict(cast(dict[str, object], node.get("state") or _EMPTY_STATE))
        destination_origin = None
        required_inputs: list[str] = []
        confidence = 0.95
        if kind == "link":
            destination_origin = _origin(node.get("destination"))
            destination_class = node.get("destinationClass")
            if destination_class == "download":
                capability_kind, effect = "download_upload", "download"
            elif destination_class == "unsafe":
                capability_kind, effect, confidence = "unknown", "unknown", 0.4
            else:
                capability_kind, effect = "navigation", "navigation"
        elif kind == "field":
            capability_kind, effect = "data_entry", "data_entry"
            required_inputs = [role]
            prohibited += 1
        elif role in {"tab", "toggle", "menu_button", "popup_trigger"}:
            capability_kind, effect = "local_view_change", "local_view"
        elif role in {"media_control"}:
            capability_kind, effect = "media_control", "media"
            prohibited += 1
        else:
            capability_kind, effect, confidence = "unknown", "unknown", 0.5

        if capability_kind == "unknown":
            unknown += 1
        required = "none" if capability_kind == "local_view_change" else "action_execution"
        capabilities.append(
            {
                "capabilityId": minter.mint(),
                "semanticIntent": role.replace("_", " ")[:200],
                "controlHandle": handle,
                "owningHandle": parent_by_child.get(handle),
                "capabilityKind": capability_kind,
                "state": state,
                "requiredInputs": required_inputs,
                "destinationOrigin": destination_origin,
                "effectClass": effect,
                "confidence": confidence,
                "evidence": [{"kind": "dom_node", "nodeHandle": handle}],
                "requiredCapability": required,
            }
        )

    coverage = {
        "observedControlCount": len(capabilities),
        "safelyExploredControlCount": 0,
        "prohibitedControlCount": prohibited,
        "unknownControlCount": unknown,
        "inaccessibleRegionCount": inaccessible,
        "unobservedLazyStateCount": 0,
        "notes": ["Public default mode observed controls without interaction."],
    }
    return capabilities, coverage


__all__ = ["classify_capabilities"]
