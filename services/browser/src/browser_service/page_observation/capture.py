"""Bounded, incremental CDP DOM + Accessibility capture (P03-F01 steps 1, 3,
4; repaired by P03-R02).

Uses only the CDP DOM and Accessibility domains -- never page-authored
script -- to obtain the post-render document, same-origin/same-process
child frames, and open shadow roots, plus the accessibility tree correlated
by `backendDOMNodeId`. Cross-origin frames and closed shadow roots are
never bypassed: CDP simply does not inline their content into a pierced
response, so they are detected structurally (an `iframe`/host node with no
corresponding content) rather than probed.

**What P03-R02 changed.** This module previously issued one unlimited
``DOM.getDocument(depth=-1, pierce=True)`` and one unlimited
``Accessibility.getFullAXTree``, then applied a "deadline" to the pure
Python reduction of responses that had already fully arrived. On a large
client-rendered site the awaits *are* the stall, so that bound never
engaged and the renderer's own five-second bridge timeout fired first --
the reproduced Airbnb failure.

The production path now:

- fetches the document to a bounded depth and expands the remaining
  frontier incrementally with ``DOM.describeNode``, only while node, depth,
  frame, shadow-root, expansion, and wall-clock budget all remain;
- bounds every awaited CDP request individually (see
  :func:`browser_service.page_observation.cdp.send_bounded`);
- bounds accessibility capture separately from the DOM, and degrades to a
  scoped ``Accessibility.getPartialAXTree`` fan-out rather than failing the
  whole observation;
- reports every boundary it hit explicitly, so a partial observation is
  machine-readably partial rather than silently incomplete.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from nodriver.cdp import accessibility as cdp_ax
from nodriver.cdp import dom as cdp_dom
from nodriver.core.tab import Tab  # type: ignore[import-untyped]

from browser_service.extraction.accessibility import RawAxNode, raw_ax_node
from browser_service.page_observation.cdp import CdpTimeoutError, send_bounded

DEFAULT_MAX_RAW_NODES = 20_000
DEFAULT_MAX_DEPTH = 60
DEFAULT_CAPTURE_TIMEOUT_SECONDS = 10.0

#: Boundary reasons this module can attach to a node it chose not to expand.
#: Each is a budget outcome, never a failure of the page.
BOUNDARY_CAPTURE_BUDGET = "capture_budget_exhausted"
BOUNDARY_CAPTURE_TIMEOUT = "capture_timeout"
BOUNDARY_FRAME_BUDGET = "frame_budget_exhausted"
BOUNDARY_SHADOW_BUDGET = "shadow_root_budget_exhausted"


@dataclass(frozen=True)
class CaptureLimits:
    """Every bound one capture may not exceed.

    ``max_raw_nodes``/``max_depth``/``timeout_seconds`` are the overall
    ceilings. The remainder shape the incremental strategy that replaced the
    single unlimited pierced snapshot.
    """

    max_raw_nodes: int = DEFAULT_MAX_RAW_NODES
    max_depth: int = DEFAULT_MAX_DEPTH
    timeout_seconds: float = DEFAULT_CAPTURE_TIMEOUT_SECONDS
    #: Depth of the first `DOM.getDocument`. Deep enough to reach the main
    #: content of a typical results page in one round trip, shallow enough
    #: that a pathological document cannot make that one response unbounded.
    initial_depth: int = 8
    #: Depth of each incremental `DOM.describeNode` expansion.
    expansion_depth: int = 6
    #: Hard cap on incremental round trips, independent of the clock.
    max_expansions: int = 400
    #: Measurable response bound: children accepted from one CDP response.
    max_nodes_per_response: int = 5_000
    max_frames: int = 50
    max_shadow_roots: int = 500
    #: Wall-clock bound on any single DOM request.
    request_timeout_seconds: float = 4.0
    #: Wall-clock bound on the accessibility tree, independent of the DOM.
    ax_timeout_seconds: float = 5.0
    ax_max_depth: int = 40
    #: Fan-out of the scoped accessibility fallback when the tree times out.
    ax_scoped_node_budget: int = 40
    ax_scoped_request_timeout_seconds: float = 0.75


@dataclass
class RawNode:
    """One DOM node from the bounded snapshot, reduced to exactly what the
    rest of the pipeline needs. `node_type` follows the DOM `Node.nodeType`
    numbering (1 = element, 3 = text, 11 = document fragment / shadow
    root)."""

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
    ignored_reasons: frozenset[str]
    properties: dict[str, object]


@dataclass(frozen=True)
class CaptureResult:
    root: RawNode
    ax_by_backend_id: dict[int, AxState]
    #: The same accessibility tree in the shape Phase 2's extraction
    #: contract consumes (``browser_service.extraction.accessibility``), so
    #: one accessibility capture serves both the graph enrichment below and
    #: the document's bounded accessibility nodes.
    raw_ax_nodes: list[RawAxNode]
    dom_tag_by_backend_id: dict[int, str]
    ax_available: bool
    node_count: int
    truncated_by_node_limit: bool
    truncated_by_depth: bool
    timed_out: bool
    duplicate_or_cycle_count: int
    #: ``complete`` (the bounded tree returned), ``partial`` (the scoped
    #: fallback returned some nodes), ``timeout`` (neither returned in
    #: budget), or ``unavailable`` (the domain refused).
    ax_status: str = "complete"
    ax_node_count: int = 0
    truncated_by_expansion_limit: bool = False
    truncated_by_frame_limit: bool = False
    truncated_by_shadow_limit: bool = False
    truncated_by_response_limit: bool = False
    #: Nodes known to have unfetched children when the budget ran out. The
    #: honest measure of how incomplete this observation is.
    unexpanded_frontier_count: int = 0
    expansion_count: int = 0
    frame_count: int = 0
    shadow_root_count: int = 0

    @property
    def partial(self) -> bool:
        """Whether any budget was hit. Drives the observation's `partial`
        status and its coverage reporting."""
        return bool(
            self.truncated_by_node_limit
            or self.truncated_by_depth
            or self.timed_out
            or self.truncated_by_expansion_limit
            or self.truncated_by_frame_limit
            or self.truncated_by_shadow_limit
            or self.truncated_by_response_limit
            or self.unexpanded_frontier_count
            or self.ax_status != "complete"
        )


class CaptureUnavailableError(RuntimeError):
    """The root document itself could not be obtained inside the capture
    budget, so there is no bounded observation to reduce. Distinct from a
    partial capture, which is a usable result."""


@dataclass
class _Traversal:
    """Mutable budget accounting for one capture."""

    limits: CaptureLimits
    deadline: float
    counter: int = 0
    frames: int = 0
    shadow_roots: int = 0
    expansions: int = 0
    duplicates: int = 0
    visited: set[int] = field(default_factory=set)
    truncation: dict[str, bool] = field(default_factory=dict)
    #: `(node, backendNodeId, depth)` for nodes with children CDP has not
    #: sent yet, in document order.
    frontier: deque[tuple[RawNode, int, int]] = field(default_factory=deque)

    def out_of_time(self) -> bool:
        return time.monotonic() >= self.deadline

    def remaining(self) -> float:
        return max(0.0, self.deadline - time.monotonic())


def _attr_dict(flat: list[str] | None) -> dict[str, str]:
    if not flat:
        return {}
    return {flat[i]: flat[i + 1] for i in range(0, len(flat) - 1, 2)}


def _unfetched_child_count(node: Any, fetched: int) -> int:
    """How many children CDP says exist but did not include in this
    response. `child_node_count` is absent on hand-built fixtures and on
    node kinds that never have children, so it is read defensively."""
    declared = getattr(node, "child_node_count", None)
    if not isinstance(declared, int):
        return 0
    return max(0, declared - fetched)


def _reduce_node(node: Any, *, depth: int, state: _Traversal) -> RawNode:
    limits = state.limits
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
    if backend_id in state.visited:
        state.duplicates += 1
        raw.inaccessible_boundary_reason = "cycle_or_duplicate_reference"
        return raw
    state.visited.add(backend_id)
    state.counter += 1

    if depth >= limits.max_depth:
        state.truncation["depth"] = True
        return raw
    if state.counter >= limits.max_raw_nodes:
        state.truncation["nodes"] = True
        return raw
    if state.out_of_time():
        state.truncation["timeout"] = True
        return raw

    children: list[Any] = list(node.children or [])

    if tag == "iframe":
        raw.is_frame_owner = True
        content_document = node.content_document
        if content_document is not None:
            if state.frames >= limits.max_frames:
                state.truncation["frames"] = True
                raw.inaccessible_boundary_reason = BOUNDARY_FRAME_BUDGET
                return raw
            state.frames += 1
            children = [content_document]
        else:
            raw.frame_boundary_reason = "cross_origin_frame"
            raw.origin_hint = raw.attributes.get("src")

    for shadow_root in node.shadow_roots or []:
        if state.shadow_roots >= limits.max_shadow_roots:
            state.truncation["shadow_roots"] = True
            raw.inaccessible_boundary_reason = (
                raw.inaccessible_boundary_reason or BOUNDARY_SHADOW_BUDGET
            )
            break
        state.shadow_roots += 1
        shadow_raw = _reduce_node(shadow_root, depth=depth + 1, state=state)
        shadow_raw.is_shadow_root = True
        raw.children.append(shadow_raw)

    if tag in {"object", "embed"}:
        raw.inaccessible_boundary_reason = "plugin_or_embedded_content"

    if len(children) > limits.max_nodes_per_response:
        state.truncation["response"] = True
        children = children[: limits.max_nodes_per_response]

    for child in children:
        if state.counter >= limits.max_raw_nodes:
            state.truncation["nodes"] = True
            break
        if state.out_of_time():
            state.truncation["timeout"] = True
            break
        raw.children.append(_reduce_node(child, depth=depth + 1, state=state))

    # Children CDP knows about but did not send: the depth frontier this
    # capture expands incrementally, only while budget remains.
    if (
        raw.frame_boundary_reason is None
        and raw.inaccessible_boundary_reason is None
        and _unfetched_child_count(node, len(children)) > 0
    ):
        state.frontier.append((raw, backend_id, depth))

    return raw


async def _expand_frontier(page: Tab, state: _Traversal) -> None:
    """Fetches the children of frontier nodes incrementally, one bounded
    `DOM.describeNode` at a time, only while every budget still allows it
    (P03-R02 step 2)."""
    limits = state.limits
    while state.frontier:
        if state.expansions >= limits.max_expansions:
            state.truncation["expansions"] = True
            break
        if state.counter >= limits.max_raw_nodes:
            state.truncation["nodes"] = True
            break
        if state.out_of_time():
            state.truncation["timeout"] = True
            break

        raw, backend_id, depth = state.frontier.popleft()
        request_budget = min(limits.request_timeout_seconds, state.remaining())
        try:
            described = await send_bounded(
                page,
                cdp_dom.describe_node(
                    backend_node_id=cdp_dom.BackendNodeId(backend_id),
                    depth=limits.expansion_depth,
                    pierce=True,
                ),
                timeout_seconds=request_budget,
                phase="dom.describe_node",
            )
        except CdpTimeoutError:
            # A stalled connection stalls again; stop expanding rather than
            # spend the rest of the budget re-confirming that. The node goes
            # back on the frontier so it is still *counted* as unread --
            # popping it is what asked the question, not what answered it.
            state.truncation["timeout"] = True
            raw.inaccessible_boundary_reason = BOUNDARY_CAPTURE_TIMEOUT
            state.frontier.appendleft((raw, backend_id, depth))
            break
        except Exception:  # noqa: BLE001 -- one unexpandable node is not a failed observation
            raw.inaccessible_boundary_reason = (
                raw.inaccessible_boundary_reason or "expansion_failed"
            )
            continue

        state.expansions += 1
        children = list(getattr(described, "children", None) or [])
        if len(children) > limits.max_nodes_per_response:
            state.truncation["response"] = True
            children = children[: limits.max_nodes_per_response]
        for child in children:
            if state.counter >= limits.max_raw_nodes:
                state.truncation["nodes"] = True
                break
            if state.out_of_time():
                state.truncation["timeout"] = True
                break
            raw.children.append(_reduce_node(child, depth=depth + 1, state=state))

    # Whatever is still queued was never fetched. Say so on the node rather
    # than letting it read as a childless leaf.
    for raw, _backend_id, _depth in state.frontier:
        raw.inaccessible_boundary_reason = (
            raw.inaccessible_boundary_reason or BOUNDARY_CAPTURE_BUDGET
        )


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
    ignored_reasons = frozenset(
        str(reason.name.value) if hasattr(reason.name, "value") else str(reason.name)
        for reason in (node.ignored_reasons or [])
    )
    return AxState(
        role=str(ax_role) if ax_role is not None else None,
        name=str(name) if name else None,
        description=str(description) if description else None,
        ignored=bool(node.ignored),
        ignored_reasons=ignored_reasons,
        properties=properties,
    )


def _collect_dom_tags(node: RawNode, tags: dict[int, str]) -> None:
    """Builds the ``backendDOMNodeId -> tag name`` map the accessibility
    reduction correlates against, from the already-bounded DOM snapshot."""
    stack = [node]
    while stack:
        current = stack.pop()
        if current.node_type == 1 and current.tag:
            tags[current.backend_node_id] = current.tag
        stack.extend(current.children)


def _scope_candidates(root: RawNode, budget: int) -> list[int]:
    """Backend ids the scoped accessibility fallback asks about, in document
    order: the elements most likely to carry the page's records."""
    ordered: list[int] = []
    queue: deque[RawNode] = deque([root])
    while queue and len(ordered) < budget:
        current = queue.popleft()
        skipped = {"script", "style", "head", "meta", "link"}
        if current.node_type == 1 and current.tag not in skipped:
            ordered.append(current.backend_node_id)
        queue.extend(current.children)
    return ordered[:budget]


async def _capture_accessibility(
    page: Tab, root: RawNode, limits: CaptureLimits, deadline: float
) -> tuple[list[Any], str]:
    """Bounded accessibility capture, independent of the DOM budget
    (P03-R02 step 3).

    Prefers the depth-bounded full tree; degrades to a scoped
    `getPartialAXTree` fan-out over already-captured nodes; reports
    ``timeout``/``unavailable`` explicitly rather than failing the whole
    observation or pretending the tree was complete.
    """
    remaining = max(0.0, deadline - time.monotonic())
    if remaining <= 0:
        return [], "timeout"
    try:
        nodes = await send_bounded(
            page,
            cdp_ax.get_full_ax_tree(depth=limits.ax_max_depth),
            timeout_seconds=min(limits.ax_timeout_seconds, remaining),
            phase="ax.get_full_ax_tree",
        )
        return list(nodes or []), "complete"
    except CdpTimeoutError:
        pass
    except Exception:  # noqa: BLE001 -- accessibility is enrichment, never the observation
        return [], "unavailable"

    scoped: list[Any] = []
    for backend_id in _scope_candidates(root, limits.ax_scoped_node_budget):
        if time.monotonic() >= deadline:
            break
        try:
            partial = await send_bounded(
                page,
                cdp_ax.get_partial_ax_tree(
                    backend_node_id=cdp_dom.BackendNodeId(backend_id), fetch_relatives=False
                ),
                timeout_seconds=min(
                    limits.ax_scoped_request_timeout_seconds,
                    max(0.0, deadline - time.monotonic()),
                ),
                phase="ax.get_partial_ax_tree",
            )
        except CdpTimeoutError:
            break
        except Exception:  # noqa: BLE001 -- one unreachable node, not a failure
            continue
        scoped.extend(partial or [])
    return scoped, ("partial" if scoped else "timeout")


async def capture_page(page: Tab, limits: CaptureLimits | None = None) -> CaptureResult:
    """Captures one bounded DOM snapshot plus bounded accessibility state.

    Every awaited CDP request carries its own wall-clock bound, and the
    traversal stops on whichever of node count, depth, frame count,
    shadow-root count, expansion count, per-response size, or total time
    runs out first. Never touches page-authored script; every fetch is a
    plain CDP domain command.

    Raises :class:`CaptureUnavailableError` only when the root document
    itself could not be obtained -- every lesser shortfall produces a
    usable, explicitly-partial result.
    """
    cfg = limits if limits is not None else CaptureLimits()
    deadline = time.monotonic() + cfg.timeout_seconds
    state = _Traversal(limits=cfg, deadline=deadline)

    try:
        document = await send_bounded(
            page,
            cdp_dom.get_document(depth=cfg.initial_depth, pierce=True),
            timeout_seconds=min(cfg.request_timeout_seconds, cfg.timeout_seconds),
            phase="dom.get_document",
        )
    except CdpTimeoutError as exc:
        raise CaptureUnavailableError(
            "The page document could not be read within its budget."
        ) from exc

    root = _reduce_node(document, depth=0, state=state)
    await _expand_frontier(page, state)

    dom_tag_by_backend_id: dict[int, str] = {}
    _collect_dom_tags(root, dom_tag_by_backend_id)

    ax_nodes, ax_status = await _capture_accessibility(page, root, cfg, deadline)

    ax_by_backend_id: dict[int, AxState] = {}
    for ax_node in ax_nodes:
        parsed = _parse_ax_node(ax_node)
        if parsed is not None and ax_node.backend_dom_node_id is not None:
            ax_by_backend_id[int(ax_node.backend_dom_node_id)] = parsed

    return CaptureResult(
        root=root,
        ax_by_backend_id=ax_by_backend_id,
        raw_ax_nodes=[raw_ax_node(node) for node in ax_nodes],
        dom_tag_by_backend_id=dom_tag_by_backend_id,
        ax_available=bool(ax_nodes),
        node_count=state.counter,
        truncated_by_node_limit=bool(state.truncation.get("nodes", False)),
        truncated_by_depth=bool(state.truncation.get("depth", False)),
        timed_out=bool(state.truncation.get("timeout", False)),
        duplicate_or_cycle_count=state.duplicates,
        ax_status=ax_status,
        ax_node_count=len(ax_nodes),
        truncated_by_expansion_limit=bool(state.truncation.get("expansions", False)),
        truncated_by_frame_limit=bool(state.truncation.get("frames", False)),
        truncated_by_shadow_limit=bool(state.truncation.get("shadow_roots", False)),
        truncated_by_response_limit=bool(state.truncation.get("response", False)),
        unexpanded_frontier_count=len(state.frontier),
        expansion_count=state.expansions,
        frame_count=state.frames,
        shadow_root_count=state.shadow_roots,
    )


__all__ = [
    "BOUNDARY_CAPTURE_BUDGET",
    "BOUNDARY_CAPTURE_TIMEOUT",
    "BOUNDARY_FRAME_BUDGET",
    "BOUNDARY_SHADOW_BUDGET",
    "AxState",
    "CaptureLimits",
    "CaptureResult",
    "CaptureUnavailableError",
    "RawNode",
    "capture_page",
]
