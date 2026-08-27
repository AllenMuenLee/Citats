"""Classifies a captured DOM+accessibility tree into the canonical,
bounded `PageUnderstanding` graph (P03-F02): nodes, relationships,
regions, repeated collections, and source-candidate field mappings.

Only elements with real semantic/interactive meaning become nodes --
generic layout wrappers (a `div`/`span` with no ARIA role, no text, and no
part in a detected repeated pattern) are traversed for their children but
never emitted themselves, keeping the graph meaningful rather than a
1:1 DOM dump.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from browser_service.page_observation.capture import AxState, RawNode
from browser_service.page_observation.handles import HandleMinter
from browser_service.page_observation.safety import (
    attribute_hidden,
    classify_url,
    destination_class,
    hidden_text_has_injection,
    sanitize_visible_text,
)

MAX_TEXT_LENGTH = 2_000
MAX_LABEL_LENGTH = 300
MAX_FLATTEN_DEPTH = 4
MAX_FLATTEN_NODES = 40
REPEATED_GROUP_MIN_SIZE = 3

_PRICE_RE = re.compile(r"^[$£€¥]\s?\d[\d,.]*|^\d[\d,.]*\s?(USD|EUR|GBP)\b", re.IGNORECASE)
_RATING_RE = re.compile(r"\b\d(\.\d)?\s*(out of|/)\s*5\b|\b\d(\.\d)?\s*stars?\b", re.IGNORECASE)
_AVAILABILITY_RE = re.compile(
    r"\b(in stock|out of stock|sold out|available|unavailable|only \d+ left|"
    r"limited availability)\b",
    re.IGNORECASE,
)

_INPUT_TYPE_TO_FIELD_ROLE = {
    "text": "text",
    "search": "search",
    "email": "email",
    "tel": "tel",
    "url": "url",
    "password": "password",
    "date": "date",
    "time": "time",
    "month": "month",
    "week": "week",
    "number": "number",
    "range": "range",
    "color": "color",
    "file": "file",
    "hidden": "hidden",
    "checkbox": "checkbox",
    "radio": "radio",
}

_LANDMARK_TAGS = {
    "header": "banner",
    "footer": "contentinfo",
    "nav": "navigation",
    "main": "main",
    "aside": "complementary",
}
_LANDMARK_ROLES = {
    "main",
    "navigation",
    "search",
    "banner",
    "contentinfo",
    "complementary",
    "region",
    "form",
}

_CONTROL_ROLE_ATTR = {
    "button": "button",
    "menuitem": "menu_button",
    "switch": "toggle",
    "tab": "tab",
    "checkbox": "toggle",
    "menu": "popup_trigger",
}
_DIALOG_ROLE_ATTR = {"dialog": "dialog", "alertdialog": "alert_dialog", "tooltip": "tooltip"}
_FEEDBACK_ROLE_ATTR = {
    "alert": "alert",
    "status": "status",
    "progressbar": "progress_bar",
    "log": "live_region",
}


@dataclass
class EmittedNode:
    handle: str
    payload: dict[str, object]
    raw: RawNode
    parent_handle: str | None
    order_index: int


@dataclass
class GraphBuildResult:
    nodes: list[dict[str, object]] = field(default_factory=list)
    relationships: list[dict[str, object]] = field(default_factory=list)
    regions: list[dict[str, object]] = field(default_factory=list)
    collections: list[dict[str, object]] = field(default_factory=list)
    source_candidates: list[dict[str, object]] = field(default_factory=list)
    warnings: list[dict[str, object]] = field(default_factory=list)
    truncations: list[dict[str, object]] = field(default_factory=list)
    backend_id_by_handle: dict[str, int] = field(default_factory=dict)


def _flatten_text(node: RawNode, *, depth: int = 0, budget: list[int] | None = None) -> str:
    if budget is None:
        budget = [MAX_FLATTEN_NODES]
    if depth > MAX_FLATTEN_DEPTH or budget[0] <= 0:
        return ""
    parts: list[str] = []
    if node.node_type == 3 and node.text:
        parts.append(node.text)
    for child in node.children:
        if budget[0] <= 0:
            break
        budget[0] -= 1
        # Do not pull an interactive descendant's own label into an ancestor's label.
        if child.tag in ("button", "a", "select", "textarea", "input", "form"):
            continue
        text = _flatten_text(child, depth=depth + 1, budget=budget)
        if text:
            parts.append(text)
    return " ".join(p for p in parts if p).strip()


def _accessible_label(node: RawNode, ax: AxState | None) -> str | None:
    if ax is not None and ax.name:
        return ax.name
    for attr in ("aria-label", "alt", "title", "placeholder"):
        if node.attributes.get(attr):
            return node.attributes[attr]
    text = _flatten_text(node)
    return text or None


def _bool_prop(ax: AxState | None, name: str) -> bool | None:
    if ax is None:
        return None
    value = ax.properties.get(name)
    if isinstance(value, bool):
        return value
    return None


def _control_state(ax: AxState | None, *, disabled_attr: bool) -> dict[str, object]:
    return {
        "expanded": _bool_prop(ax, "expanded"),
        "pressed": _bool_prop(ax, "pressed"),
        "checked": _bool_prop(ax, "checked"),
        "selected": _bool_prop(ax, "selected"),
        "current": _bool_prop(ax, "current"),
        "busy": bool(_bool_prop(ax, "busy")),
        "invalid": bool(_bool_prop(ax, "invalid")),
        "required": bool(_bool_prop(ax, "required")),
        "disabled": bool(disabled_attr or _bool_prop(ax, "disabled")),
        "readOnly": bool(ax and ax.properties.get("readonly")),
        "focusable": bool(_bool_prop(ax, "focusable")),
    }


# CDP's Accessibility.ignoredReasons codes that mean the node is actually
# invisible/unreachable to users. `ignored=True` alone is not a hidden
# signal: Chromium also marks purely structural/semantic-less nodes ignored
# (reason "uninteresting") -- notably the page's own <html> element, which
# is folded into RootWebArea rather than exposed as its own accessible
# node. Empirically, every page's <html> comes back `ignored=True,
# ignoredReasons=["uninteresting"]`, so treating any `ignored=True` node as
# hidden (as this used to) pruned every page's entire subtree at the root,
# always producing an empty graph regardless of site. Only the reasons
# below indicate real invisibility; anything else (uninteresting,
# presentational roles, empty alt/label text, etc.) is a "traverse for
# children but don't emit this node itself" wrapper, per this module's own
# docstring, not hidden content.
_HIDDEN_IGNORED_REASONS = frozenset(
    {
        "activeModalDialog",
        "ariaHiddenElement",
        "ariaHiddenSubtree",
        "hiddenByChildTree",
        "inertElement",
        "inertSubtree",
        "notRendered",
        "notVisible",
    }
)


def _is_hidden(node: RawNode, ax: AxState | None) -> bool:
    if attribute_hidden(node.attributes):
        return True
    if ax is None:
        return False
    if not ax.ignored:
        return False
    if not ax.ignored_reasons:
        return True
    return bool(ax.ignored_reasons & _HIDDEN_IGNORED_REASONS)


def _text_role_and_text(node: RawNode, tag: str, label: str | None) -> tuple[str, str] | None:
    heading_tags = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
    text = label or _flatten_text(node)
    if not text:
        return None
    role = {
        "p": "paragraph",
        "blockquote": "quote",
        "q": "quote",
        "cite": "citation",
        "code": "code",
        "pre": "code",
        "kbd": "keyboard_input",
        "dfn": "definition",
        "abbr": "abbreviation",
        "address": "address",
        "time": "time",
        "figcaption": "figure_caption",
        "hr": "separator",
    }.get(tag)
    if tag in heading_tags:
        role = "heading"
    if role is None and tag in ("span", "label", "li", "dt", "dd", "div"):
        role = "span" if tag != "label" else "label"
    if role is None:
        return None
    if _PRICE_RE.search(text):
        role = "price"
    elif _RATING_RE.search(text):
        role = "rating"
    elif _AVAILABILITY_RE.search(text):
        role = "availability"
    return role, text


def _classify(
    node: RawNode, ax: AxState | None, *, base_url: str, page_origin: str, page_url: str
) -> tuple[str, dict[str, object]] | None:
    """Returns `(kind, kind_specific_fields)` for `node`, or `None` if it
    is a purely structural wrapper that should not become its own node."""
    tag = node.tag
    attrs = node.attributes
    role_attr = attrs.get("role", "").strip().lower()
    label = _accessible_label(node, ax)

    if node.frame_boundary_reason is not None:
        return "embedded_boundary", {
            "boundaryType": "cross_origin_frame",
            "originOrTitle": node.origin_hint,
            "reason": "Cross-origin iframe content is not observable from this frame.",
        }
    if node.is_shadow_root and node.attributes.get("__closed__") == "true":
        return "embedded_boundary", {
            "boundaryType": "closed_shadow_root",
            "originOrTitle": None,
            "reason": "Closed shadow root content is not accessible.",
        }

    if tag in _LANDMARK_TAGS or role_attr in _LANDMARK_ROLES:
        landmark_role = role_attr if role_attr in _LANDMARK_ROLES else _LANDMARK_TAGS.get(tag)
        if landmark_role:
            return "landmark", {"role": landmark_role, "label": label}
    if tag in ("main",):
        return "landmark", {"role": "main", "label": label}
    if tag == "article":
        return "landmark", {"role": "article", "label": label}
    if tag == "section" and label:
        return "landmark", {"role": "section", "label": label}

    if tag == "img":
        src, _reason = classify_url(attrs.get("src"), base_url=base_url)
        alt = attrs.get("alt")
        img_role = "photo"
        haystack = f"{attrs.get('class', '')} {alt or ''}".lower()
        if "logo" in haystack:
            img_role = "logo"
        elif "avatar" in haystack:
            img_role = "avatar"
        elif "icon" in haystack:
            img_role = "icon"
        elif "thumbnail" in haystack or "thumb" in haystack:
            img_role = "thumbnail"
        width = attrs.get("width")
        height = attrs.get("height")
        return "image", {
            "role": img_role,
            "altText": sanitize_visible_text(alt, max_length=MAX_LABEL_LENGTH)[0],
            "source": src,
            "intrinsicWidth": int(width) if width and width.isdigit() else None,
            "intrinsicHeight": int(height) if height and height.isdigit() else None,
        }
    if tag == "svg":
        return "svg_chart", {"role": "illustration", "label": label}
    if tag == "canvas":
        return "canvas_region", {"label": label, "description": None}
    if tag == "audio":
        return "audio", {
            "title": label,
            "hasControls": "controls" in attrs,
            "durationSeconds": None,
            "currentTimeSeconds": None,
            "playbackState": "unknown",
            "hasCaptions": False,
        }
    if tag == "video":
        poster, _ = classify_url(attrs.get("poster"), base_url=base_url)
        return "video", {
            "title": label,
            "hasControls": "controls" in attrs,
            "durationSeconds": None,
            "currentTimeSeconds": None,
            "playbackState": "unknown",
            "hasCaptions": False,
            "posterSource": poster,
        }

    if tag == "a" or role_attr == "link":
        href = attrs.get("href")
        dest, _reason = classify_url(href, base_url=base_url)
        dest_class = (
            destination_class(dest, page_origin=page_origin, page_url=page_url)
            if href
            else "unsafe"
        )
        if href and dest is None:
            dest_class = "unsafe"
        link_role = "link"
        if role_attr == "tab":
            link_role = "tab"
        return "link", {
            "role": link_role,
            "label": label,
            "destination": dest,
            "destinationClass": dest_class,
        }

    if (
        tag in ("button",)
        or role_attr in _CONTROL_ROLE_ATTR
        or (tag == "input" and attrs.get("type") in ("submit", "button", "reset"))
    ):
        control_role = _CONTROL_ROLE_ATTR.get(role_attr, "button")
        return "control", {
            "role": control_role,
            "label": label,
            "state": _control_state(ax, disabled_attr="disabled" in attrs),
        }

    if tag == "form":
        method = attrs.get("method", "get").lower()
        method_class = "safe" if method in ("get", "") else "unsafe"
        return "form", {"label": label, "methodClass": method_class}

    if tag in ("select", "textarea") or tag == "input":
        if tag == "select":
            field_role = "combobox" if role_attr == "combobox" else "select"
        elif tag == "textarea":
            field_role = "textarea"
        else:
            input_type = attrs.get("type", "text").lower()
            if input_type in ("submit", "button", "reset"):
                return None
            field_role = _INPUT_TYPE_TO_FIELD_ROLE.get(input_type, "text")
        return "field", {
            "role": field_role,
            "label": label,
            "required": "required" in attrs,
            "disabled": "disabled" in attrs,
            "readOnly": "readonly" in attrs,
        }
    if tag == "option":
        return "option", {
            "label": label,
            "selected": "selected" in attrs,
            "disabled": "disabled" in attrs,
        }

    if tag == "dialog" or role_attr in _DIALOG_ROLE_ATTR:
        dialog_role = _DIALOG_ROLE_ATTR.get(role_attr, "dialog")
        return "dialog", {
            "role": dialog_role,
            "modal": bool(_bool_prop(ax, "modal")) or tag == "dialog",
            "label": label,
        }

    if role_attr in _FEEDBACK_ROLE_ATTR or tag == "progress" or tag == "meter":
        feedback_role = _FEEDBACK_ROLE_ATTR.get(role_attr) or (
            "progress_bar" if tag == "progress" else "meter"
        )
        return "feedback", {"role": feedback_role, "text": label}

    if tag in ("ul", "ol") or role_attr in ("list", "menu", "tablist", "tree", "toolbar"):
        list_role = {
            "tablist": "tab_list",
            "tree": "tree",
            "toolbar": "toolbar",
            "menu": "menu",
        }.get(role_attr, "list")
        item_count = sum(
            1 for c in node.children if c.tag in ("li",) or c.attributes.get("role") == "listitem"
        )
        return "list", {
            "role": list_role,
            "ordered": tag == "ol" if tag in ("ul", "ol") else None,
            "itemCount": item_count,
            "nested": False,
            "truncated": False,
        }
    if tag == "dl":
        return "list", {
            "role": "description_list",
            "ordered": None,
            "itemCount": len(node.children),
            "nested": False,
            "truncated": False,
        }
    if tag == "table" or role_attr in ("grid", "treegrid"):
        table_role = (
            "treegrid" if role_attr == "treegrid" else ("grid" if role_attr == "grid" else "table")
        )
        rows = [c for c in node.children if c.tag == "tbody"]
        row_count = 0
        for body in rows or [node]:
            row_count += sum(1 for c in body.children if c.tag == "tr")
        return "table", {
            "role": table_role,
            "caption": label,
            "rowCount": row_count,
            "columnCount": 0,
            "truncated": False,
        }

    text_classification = _text_role_and_text(node, tag, label)
    if tag in ("strong", "b", "em", "i", "ins", "mark", "del", "s", "sup", "sub"):
        emphasis_map = {
            "strong": "strong",
            "b": "strong",
            "em": "emphasis",
            "i": "emphasis",
            "ins": "inserted",
            "mark": "marked",
            "del": "deleted",
            "s": "deleted",
            "sup": "superscript",
            "sub": "subscript",
        }
        text = label or _flatten_text(node)
        if not text:
            return None
        return "rich_text", {"text": text, "emphasis": [emphasis_map[tag]]}

    if text_classification is not None:
        role, text = text_classification
        heading_level = int(tag[1]) if tag in ("h1", "h2", "h3", "h4", "h5", "h6") else None
        return "text", {"role": role, "text": text, "headingLevel": heading_level}

    return None


__all__ = [
    "EmittedNode",
    "GraphBuildResult",
    "MAX_LABEL_LENGTH",
    "MAX_TEXT_LENGTH",
    "REPEATED_GROUP_MIN_SIZE",
    "build_graph",
]


def build_graph(  # noqa: C901 -- classification pass is inherently branchy; see module docstring
    root: RawNode,
    ax_by_backend_id: dict[int, AxState],
    *,
    page_url: str,
    page_origin: str,
    max_nodes: int,
) -> GraphBuildResult:
    result = GraphBuildResult()
    handles = HandleMinter("node")
    region_handles = HandleMinter("region")
    collection_handles = HandleMinter("collection")

    emitted: list[EmittedNode] = []
    emitted_by_backend_id: dict[int, EmittedNode] = {}
    node_limit_hit = [False]

    def visit(node: RawNode, parent: EmittedNode | None) -> None:
        if len(emitted) >= max_nodes:
            node_limit_hit[0] = True
            return
        ax = ax_by_backend_id.get(node.backend_node_id)
        if node.node_type == 1 and _is_hidden(node, ax):
            if hidden_text_has_injection(_flatten_text(node)):
                result.warnings.append(
                    {
                        "code": "hidden_injection_detected",
                        "message": (
                            "A hidden element contained text resembling an instruction-override "
                            "attempt; it was omitted from the graph."
                        ),
                        "nodeHandle": None,
                    }
                )
            return

        classified = None
        if node.node_type == 1:
            classified = _classify(
                node, ax, base_url=page_url, page_origin=page_origin, page_url=page_url
            )

        current_parent = parent
        if classified is not None:
            kind, fields = classified
            handle = handles.mint()
            box_model_pending = kind not in ("option",)
            payload: dict[str, object] = {
                "kind": kind,
                "handle": handle,
                "boundingBox": None,
                "visibility": "hidden" if False else "visible",
                **fields,
            }
            if not box_model_pending:
                payload.pop("boundingBox", None)
                payload["boundingBox"] = None
            emitted_node = EmittedNode(
                handle=handle,
                payload=payload,
                raw=node,
                parent_handle=parent.handle if parent else None,
                order_index=len(emitted),
            )
            emitted.append(emitted_node)
            emitted_by_backend_id[node.backend_node_id] = emitted_node
            result.backend_id_by_handle[handle] = node.backend_node_id
            if parent is not None:
                result.relationships.append(
                    {
                        "kind": "parent_child",
                        "from": parent.handle,
                        "to": handle,
                        "order": emitted_node.order_index,
                    }
                )
            if len(emitted) >= 2:
                pass  # reading-order edges are added in a second pass below
            current_parent = emitted_node

        for child in node.children:
            if len(emitted) >= max_nodes:
                node_limit_hit[0] = True
                break
            visit(child, current_parent)

    visit(root, None)

    if node_limit_hit[0]:
        result.warnings.append(
            {
                "code": "node_limit_reached",
                "message": (
                    f"The page-understanding graph reached its {max_nodes}-node bound; "
                    "remaining content was omitted."
                ),
                "nodeHandle": None,
            }
        )
        result.truncations.append(
            {"reason": "node limit reached", "category": "nodes", "removedCount": 0}
        )

    for i in range(len(emitted) - 1):
        result.relationships.append(
            {
                "kind": "reading_order",
                "from": emitted[i].handle,
                "to": emitted[i + 1].handle,
                "order": i,
            }
        )

    _build_regions(emitted, result, region_handles)
    _build_collections(emitted, result, collection_handles)

    for node in emitted:
        payload = dict(node.payload)
        payload.pop("_internal", None)
        result.nodes.append(payload)

    return result


def _region_role(kind: str, fields: dict[str, object]) -> str | None:
    if kind == "landmark":
        return str(fields.get("role"))
    return None


def _build_regions(
    emitted: list[EmittedNode], result: GraphBuildResult, region_handles: HandleMinter
) -> None:
    for node in emitted:
        role = _region_role(str(node.payload["kind"]), node.payload)
        if role is None:
            continue
        child_handles = [n.handle for n in emitted if n.parent_handle == node.handle]
        result.regions.append(
            {
                "handle": region_handles.mint(),
                "role": role,
                "label": node.payload.get("label"),
                "childHandles": child_handles[:500],
            }
        )


def _record_role_for_container_role(role_hint: str) -> str:
    return {
        "search_results": "search_result",
        "product_listing": "product_card",
        "flight_schedule": "schedule_entry",
        "news_feed": "feed_item",
        "media_gallery": "generic_record",
        "comparison_group": "comparison_item",
        "timeline": "timeline_entry",
        "calendar": "calendar_entry",
    }.get(role_hint, "generic_record")


def _collection_role_hint(sibling: EmittedNode | RawNode) -> str:
    raw = sibling.raw if isinstance(sibling, EmittedNode) else sibling
    handle_prefix = raw.attributes.get("class", "").lower()
    if any(k in handle_prefix for k in ("flight", "schedule")):
        return "flight_schedule"
    if any(k in handle_prefix for k in ("product", "item", "card")):
        return "product_listing"
    if any(k in handle_prefix for k in ("result",)):
        return "search_results"
    if any(k in handle_prefix for k in ("news", "feed", "article")):
        return "news_feed"
    if any(k in handle_prefix for k in ("event", "calendar")):
        return "calendar"
    if any(k in handle_prefix for k in ("timeline",)):
        return "timeline"
    return "generic_records"


def _build_collections(
    emitted: list[EmittedNode], result: GraphBuildResult, collection_handles: HandleMinter
) -> None:
    """Groups raw DOM siblings (not only emitted nodes) sharing a tag +
    class signature, repeated at least `REPEATED_GROUP_MIN_SIZE` times, and
    each containing at least one already-emitted node, into a
    `RepeatedCollection`. Each group member becomes a `repeated_record`
    node whose children are re-parented under it (mission item 4).
    """
    by_backend_id = {n.raw.backend_node_id: n for n in emitted}
    seen_parents: set[int] = set()

    def signature(node: RawNode) -> tuple[str, str]:
        return node.tag, node.attributes.get("class", "")

    def collect_parents(node: RawNode) -> None:
        groups: dict[tuple[str, str], list[RawNode]] = {}
        for child in node.children:
            if child.node_type != 1:
                continue
            groups.setdefault(signature(child), []).append(child)
        for (tag, _cls), members in groups.items():
            if tag in ("li", "option", "tr"):
                continue
            qualifying = [m for m in members if _subtree_has_emitted(m, by_backend_id)]
            if len(qualifying) >= REPEATED_GROUP_MIN_SIZE and id(node) not in seen_parents:
                seen_parents.add(id(node))
                _emit_collection(qualifying, result, collection_handles, by_backend_id)
                break
        for child in node.children:
            collect_parents(child)

    if emitted:
        collect_parents(emitted[0].raw if emitted[0].parent_handle is None else emitted[0].raw)
    # Always walk from the true root regardless of the guard above.
    root_candidates = [n.raw for n in emitted if n.parent_handle is None]
    for candidate in root_candidates:
        collect_parents(candidate)


def _subtree_has_emitted(node: RawNode, by_backend_id: dict[int, EmittedNode]) -> bool:
    if node.backend_node_id in by_backend_id:
        return True
    return any(_subtree_has_emitted(c, by_backend_id) for c in node.children)


def _emit_collection(
    members: list[RawNode],
    result: GraphBuildResult,
    collection_handles: HandleMinter,
    by_backend_id: dict[int, EmittedNode],
) -> None:
    role_hint = (
        _collection_role_hint(
            next(m for m in members if m.backend_node_id in by_backend_id)
            if any(m.backend_node_id in by_backend_id for m in members)
            else members[0]
        )
        if members
        else "generic_records"
    )
    # Fallback role hint uses the first member with an emitted descendant, else the group itself.
    sample = next(
        (by_backend_id[m.backend_node_id] for m in members if m.backend_node_id in by_backend_id),
        None,
    )
    role_hint = _collection_role_hint(sample) if sample else "generic_records"
    collection_handle = collection_handles.mint()
    record_handles: list[str] = []
    for index, member in enumerate(members[:200]):
        record_handle = f"{collection_handle}-r{index}"
        member_emitted_children = [
            n.handle for n in by_backend_id.values() if _is_descendant(member, n.raw)
        ]
        result.nodes.append(
            {
                "kind": "repeated_record",
                "handle": record_handle,
                "boundingBox": None,
                "visibility": "visible",
                "role": _record_role_for_container_role(role_hint),
                "collectionHandle": collection_handle,
                "index": index,
            }
        )
        record_handles.append(record_handle)
        for child_handle in member_emitted_children:
            result.relationships.append(
                {"kind": "record_field", "from": record_handle, "to": child_handle, "order": None}
            )
        _build_source_candidate(record_handle, collection_handle, member_emitted_children, result)

    result.collections.append(
        {
            "handle": collection_handle,
            "role": role_hint,
            "itemCount": len(members),
            "recordHandles": record_handles,
            "truncated": len(members) > 200,
            "paginationHandle": None,
        }
    )


def _is_descendant(ancestor: RawNode, candidate: RawNode) -> bool:
    if ancestor is candidate:
        return True
    return any(_is_descendant(c, candidate) for c in ancestor.children)


def _build_source_candidate(
    record_handle: str, collection_handle: str, child_handles: list[str], result: GraphBuildResult
) -> None:
    fields: list[dict[str, object]] = []
    by_handle = {n["handle"]: n for n in result.nodes}
    action_ids: list[str] = []
    seen_roles: set[str] = set()

    def add_field(role: str, handle: str) -> None:
        if role in seen_roles:
            return
        seen_roles.add(role)
        fields.append({"role": role, "nodeHandle": handle, "confidence": 0.7})

    for handle in child_handles:
        node = by_handle.get(handle)
        if node is None:
            continue
        kind = node.get("kind")
        if kind == "text":
            role = node.get("role")
            if role == "heading":
                add_field("title", handle)
            elif role == "price":
                add_field("price", handle)
            elif role == "rating":
                add_field("rating", handle)
            elif role == "availability":
                add_field("availability", handle)
            elif role == "time":
                add_field("date", handle)
            elif role == "paragraph" and "description" not in seen_roles:
                add_field("description", handle)
        elif kind == "image":
            add_field("image", handle)
        elif kind == "video":
            add_field("video", handle)
        elif kind == "audio":
            add_field("audio", handle)
        elif kind in ("link", "control"):
            action_ids.append(handle)

    if not fields and not action_ids:
        return
    result.source_candidates.append(
        {
            "collectionHandle": collection_handle,
            "recordHandle": record_handle,
            "fields": fields[:24],
            "actionCapabilityIds": [],
        }
    )
    result.backend_id_by_handle.setdefault(record_handle + "__actions", 0)
    result._pending_action_handles = getattr(result, "_pending_action_handles", {})  # type: ignore[attr-defined]
    result._pending_action_handles[record_handle] = action_ids  # type: ignore[attr-defined]
