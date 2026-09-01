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


#: Deterministic, page-independent intent text for each trusted capability
#: kind. Phase 3 never lets an untrusted page label author this string; the
#: extraction model may later refine it, but only through the same validated
#: `CapabilityPromptTemplateSchema` boundary.
_PROMPT_TEMPLATES = {
    "navigation": "Open the linked page for the selected item on this website.",
    "download_upload": "Retrieve the linked file for the selected item on this website.",
    "data_entry": "Enter the requested details into the selected field on this website.",
    "form_submission": "Submit the selected form on this website.",
    "account_authentication": "Continue with the selected sign-in step on this website.",
    "clipboard_share": "Share the selected item from this website.",
    "communication": "Contact the provider for the selected item on this website.",
    "reservation_purchase_payment": (
        "Start the booking or purchase for the selected item on this website, "
        "and wait for the user to confirm before committing."
    ),
    "deletion_cancellation": (
        "Cancel the selected item on this website, and wait for the user to confirm."
    ),
    "media_control": "Control playback for the selected media item on this website.",
    "external_application": "Continue the selected item in the external application it opens.",
    "unknown": "Activate the selected control on this website.",
}


def _origin(destination: object) -> str | None:
    if not isinstance(destination, str):
        return None
    parsed = urlsplit(destination)
    return f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme in {"http", "https"} else None


def _argument_schema(
    capability_kind: str, required_inputs: list[str]
) -> list[dict[str, object]]:
    """The allowlisted arguments an external capability accepts.

    Names and coarse types only, derived from the trusted classification --
    never a value the page supplied, and never a credential or payment
    field, which stay behind an opaque browser-held profile handle in
    Phase 5.
    """
    arguments: list[dict[str, object]] = [
        {"name": "selection", "type": "string", "required": True, "values": None}
    ]
    if capability_kind == "data_entry":
        arguments = [
            {"name": _argument_name(name), "type": "string", "required": True, "values": None}
            for name in required_inputs
        ] or arguments
    return arguments[:12]


def _argument_name(raw: str) -> str:
    cleaned = "".join(char if char.isalnum() else "_" for char in raw.strip().lower())
    cleaned = cleaned.strip("_") or "value"
    if not cleaned[0].isalpha():
        cleaned = f"v_{cleaned}"
    return cleaned[:60]


def classify_capabilities(
    nodes: list[dict[str, object]], relationships: list[dict[str, object]]
) -> tuple[list[dict[str, object]], dict[str, object]]:
    """Classify trusted node kinds/roles only; labels never lower risk.

    Phase 3's public default is observation-only, so the coverage report
    always records zero safely explored controls.
    """
    minter = HandleMinter("cap")
    template_minter = HandleMinter("tpl")
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
        # A `local_view_change` only reorders or reveals data the generated
        # component already holds, so it stays React-only. Everything else
        # would touch the real site and therefore has to travel back through
        # the trusted server as an opaque prompt-template reference.
        internal = capability_kind == "local_view_change"
        execution = "internal_react" if internal else "external_ai_action"
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
                "interactionExecution": execution,
                "promptTemplateId": None if internal else template_minter.mint(),
                "promptTemplate": None if internal else _PROMPT_TEMPLATES[capability_kind],
                "argumentSchema": (
                    [] if internal else _argument_schema(capability_kind, required_inputs)
                ),
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
