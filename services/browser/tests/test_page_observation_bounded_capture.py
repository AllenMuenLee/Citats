"""P03-R02 validation: hard wall-clock bounds around each CDP operation,
depth/node/frame/shadow/AX limits, useful partial observations,
machine-readable truncation coverage, deterministic ordering, cancellation,
and zero unbounded whole-tree calls in the large-page path.

The fixtures below stand in for the shapes that reproduced the original
failure -- very deep DOM, very wide DOM, many repeated cards, open shadow
roots, same- and cross-origin frames, large accessibility trees, stalled
CDP calls, malformed nodes -- without depending on any live site.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from browser_service.page_observation.capture import (
    BOUNDARY_CAPTURE_BUDGET,
    BOUNDARY_CAPTURE_TIMEOUT,
    BOUNDARY_FRAME_BUDGET,
    BOUNDARY_SHADOW_BUDGET,
    CaptureLimits,
    CaptureUnavailableError,
    capture_page,
)
from browser_service.page_observation.cdp import (
    BudgetClock,
    CdpTimeoutError,
    StageBudget,
    send_bounded,
)
from browser_service.page_observation.layout import capture_bounding_boxes

# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


def node(
    backend_id: int,
    name: str = "DIV",
    *,
    node_type: int = 1,
    value: str = "",
    children: list[Any] | None = None,
    child_node_count: int | None = None,
    content_document: Any = None,
    shadow_roots: list[Any] | None = None,
    attributes: list[str] | None = None,
) -> dict[str, Any]:
    """One CDP `DOM.Node`, exactly as it arrives on the wire.
    `child_node_count` deliberately defaults to the
    number of *included* children, so a fixture opts in to a depth frontier
    by declaring more children than it carries."""
    kids = children or []
    built: dict[str, Any] = {
        "backendNodeId": backend_id,
        "nodeType": node_type,
        "nodeName": name,
        "nodeValue": value,
        "attributes": attributes or [],
        "children": kids,
        "childNodeCount": len(kids) if child_node_count is None else child_node_count,
        "shadowRoots": shadow_roots or [],
    }
    if content_document is not None:
        built["contentDocument"] = content_document
    return built


def deep_chain(depth: int, *, start: int = 1) -> Any:
    """A very deep DOM: one element per level."""
    leaf = node(start + depth - 1, "SPAN")
    current = leaf
    for level in range(depth - 2, -1, -1):
        current = node(start + level, "DIV", children=[current])
    return current


def wide_cards(count: int, *, start: int = 100) -> Any:
    """A very wide DOM of repeated listing-shaped cards."""
    cards = [
        node(
            start + index,
            "ARTICLE",
            children=[node(start + 10_000 + index, "#text", node_type=3, value=f"Listing {index}")],
        )
        for index in range(count)
    ]
    return node(1, "HTML", children=[node(2, "MAIN", children=cards)])


def ax_node(backend_id: int, role: str = "article", name: str = "Listing") -> dict[str, Any]:
    """One CDP `Accessibility.AXNode`, exactly as it arrives on the wire."""
    return {
        "backendDOMNodeId": backend_id,
        "role": {"value": role},
        "name": {"value": name},
        "ignored": False,
        "ignoredReasons": [],
        "properties": [],
        "nodeId": f"ax-{backend_id}",
        "childIds": [],
    }


class FakeSession:
    """A CDP session whose individual methods can stall, fail, or answer.

    `stall` names methods that never return, which is the behaviour that
    made the real capture path hang: the await itself is the stall, so a
    deadline applied after the response arrives can never engage.
    """

    def __init__(
        self,
        *,
        document: Any = None,
        ax_nodes: list[Any] | None = None,
        partial_ax: list[Any] | None = None,
        expansions: dict[int, Any] | None = None,
        stall: frozenset[str] = frozenset(),
        fail: frozenset[str] = frozenset(),
    ) -> None:
        self.document = document
        self.ax_nodes = ax_nodes if ax_nodes is not None else []
        self.partial_ax = partial_ax if partial_ax is not None else []
        self.expansions = expansions or {}
        self.stall = stall
        self.fail = fail
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def send(self, method: str, params: dict[str, Any] | None = None) -> Any:
        given = dict(params or {})
        self.calls.append((method, given))
        if method in self.stall:
            await asyncio.sleep(3_600)
        if method in self.fail:
            raise RuntimeError("cdp domain refused")
        if method == "DOM.getDocument":
            return {"root": self.document}
        if method == "DOM.describeNode":
            return {"node": self.expansions.get(int(given["backendNodeId"]), node(0, "DIV"))}
        if method == "Accessibility.getFullAXTree":
            return {"nodes": self.ax_nodes}
        if method == "Accessibility.getPartialAXTree":
            return {"nodes": self.partial_ax}
        if method == "DOM.getBoxModel":
            return {"model": {"content": [0, 0, 10, 0, 10, 5, 0, 5]}}
        raise AssertionError(f"unexpected command: {method}")

    def on(self, event: str, handler: Any) -> None:
        raise AssertionError("the capture path must not subscribe to events")

    def remove_listener(self, event: str, handler: Any) -> None:
        raise AssertionError("the capture path must not subscribe to events")

    def methods(self) -> list[str]:
        return [method for method, _ in self.calls]

    def params_for(self, method: str) -> list[dict[str, Any]]:
        return [params for name, params in self.calls if name == method]


# --------------------------------------------------------------------------
# Step 2: no unbounded whole-tree calls
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_large_page_path_never_issues_an_unbounded_pierced_snapshot() -> None:
    session = FakeSession(document=wide_cards(200), ax_nodes=[ax_node(100)])

    await capture_page(session, CaptureLimits(timeout_seconds=5))

    requests = session.params_for("DOM.getDocument")
    assert requests, "the document must still be fetched"
    for params in requests:
        # `depth=-1` is the unlimited pierced snapshot P03-R02 removes.
        assert params["depth"] != -1
        assert 0 < int(params["depth"]) <= CaptureLimits().initial_depth
    for params in session.params_for("Accessibility.getFullAXTree"):
        assert int(params["depth"]) == CaptureLimits().ax_max_depth


@pytest.mark.asyncio
async def test_frontier_children_are_fetched_incrementally_and_spliced_in() -> None:
    # A container CDP truncated at the depth boundary: it declares three
    # children and carries none.
    container = node(50, "SECTION", children=[], child_node_count=3)
    root = node(1, "HTML", children=[container])
    expansion = node(
        50,
        "SECTION",
        children=[node(51, "ARTICLE"), node(52, "ARTICLE"), node(53, "ARTICLE")],
    )
    session = FakeSession(document=root, expansions={50: expansion})

    result = await capture_page(session, CaptureLimits(timeout_seconds=5))

    assert session.params_for("DOM.describeNode") == [
        {"backendNodeId": 50, "depth": CaptureLimits().expansion_depth, "pierce": True}
    ]
    assert [child.backend_node_id for child in result.root.children[0].children] == [51, 52, 53]
    assert result.expansion_count == 1
    assert result.unexpanded_frontier_count == 0
    assert result.partial is False


@pytest.mark.asyncio
async def test_expansion_round_trips_are_capped_independently_of_the_clock() -> None:
    containers = [node(200 + i, "SECTION", children=[], child_node_count=2) for i in range(10)]
    session = FakeSession(
        document=node(1, "HTML", children=containers),
        expansions={
            200 + i: node(200 + i, "SECTION", children=[node(300 + i, "P")]) for i in range(10)
        },
    )

    result = await capture_page(session, CaptureLimits(timeout_seconds=30, max_expansions=3))

    assert result.expansion_count == 3
    assert result.truncated_by_expansion_limit is True
    assert result.unexpanded_frontier_count == 7
    # Every unexpanded node says so, rather than reading as a childless leaf.
    unexpanded = [child for child in result.root.children if not child.children]
    assert unexpanded
    assert all(
        child.inaccessible_boundary_reason == BOUNDARY_CAPTURE_BUDGET for child in unexpanded
    )


# --------------------------------------------------------------------------
# Step 1: hard wall-clock bounds around each awaited CDP request
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_stalled_document_request_fails_fast_instead_of_hanging() -> None:
    session = FakeSession(document=wide_cards(5), stall=frozenset({"DOM.getDocument"}))

    async with asyncio.timeout(3):
        with pytest.raises(CaptureUnavailableError):
            await capture_page(
                session, CaptureLimits(timeout_seconds=1, request_timeout_seconds=0.2)
            )


@pytest.mark.asyncio
async def test_a_stalled_expansion_yields_a_useful_partial_observation() -> None:
    container = node(50, "SECTION", children=[], child_node_count=6)
    root = node(1, "HTML", children=[node(2, "ARTICLE"), node(3, "ARTICLE"), container])
    session = FakeSession(
        document=root, stall=frozenset({"DOM.describeNode"}), ax_nodes=[ax_node(2)]
    )

    async with asyncio.timeout(5):
        result = await capture_page(
            session, CaptureLimits(timeout_seconds=2, request_timeout_seconds=0.2)
        )

    # The already-captured records survive -- a partial observation that
    # safely contains useful records beats an all-or-nothing timeout.
    assert [child.backend_node_id for child in result.root.children[:2]] == [2, 3]
    assert result.timed_out is True
    assert result.partial is True
    assert (
        result.root.children[2].inaccessible_boundary_reason == BOUNDARY_CAPTURE_TIMEOUT
    )


@pytest.mark.asyncio
async def test_a_stalled_accessibility_tree_degrades_to_a_scoped_fallback() -> None:
    session = FakeSession(
        document=wide_cards(4),
        stall=frozenset({"Accessibility.getFullAXTree"}),
        partial_ax=[ax_node(100)],
    )

    async with asyncio.timeout(5):
        result = await capture_page(
            session,
            CaptureLimits(timeout_seconds=3, ax_timeout_seconds=0.2, ax_scoped_node_budget=3),
        )

    assert result.ax_status == "partial"
    assert result.ax_available is True
    scoped_requests = session.params_for("Accessibility.getPartialAXTree")
    assert len(scoped_requests) == 3
    # Scoped requests never fetch relatives -- that is what makes them bounded.
    assert all(params["fetchRelatives"] is False for params in scoped_requests)


@pytest.mark.asyncio
async def test_accessibility_failure_never_fails_the_whole_observation() -> None:
    stalled_everything = FakeSession(
        document=wide_cards(3),
        stall=frozenset({"Accessibility.getFullAXTree", "Accessibility.getPartialAXTree"}),
    )
    async with asyncio.timeout(6):
        timed_out = await capture_page(
            stalled_everything,
            CaptureLimits(
                timeout_seconds=3,
                ax_timeout_seconds=0.2,
                ax_scoped_node_budget=2,
                ax_scoped_request_timeout_seconds=0.2,
            ),
        )
    assert timed_out.ax_status == "timeout"
    assert timed_out.ax_available is False
    assert timed_out.node_count > 0

    refused = FakeSession(document=wide_cards(3), fail=frozenset({"Accessibility.getFullAXTree"}))
    unavailable = await capture_page(refused, CaptureLimits(timeout_seconds=3))
    assert unavailable.ax_status == "unavailable"
    assert unavailable.node_count > 0


@pytest.mark.asyncio
async def test_layout_lookup_is_bounded_per_request_and_per_stage() -> None:
    session = FakeSession(document=node(1, "HTML"), stall=frozenset({"DOM.getBoxModel"}))

    async with asyncio.timeout(5):
        captured = await capture_bounding_boxes(
            session, [1, 2, 3], budget_seconds=0.6, request_timeout_seconds=0.2
        )

    assert captured.timed_out is True
    assert captured.measured_count == 0
    assert captured.skipped_count == 3
    # A node that was never measured is absent, not reported as box-less.
    assert captured.boxes == {}


@pytest.mark.asyncio
async def test_send_bounded_refuses_a_vanishing_budget_without_issuing_a_request() -> None:
    session = FakeSession(document=node(1, "HTML"))
    with pytest.raises(CdpTimeoutError) as excinfo:
        await send_bounded(session, "DOM.enable", timeout_seconds=0.0, phase="dom.enable")
    assert excinfo.value.phase == "dom.enable"
    assert session.calls == []


# --------------------------------------------------------------------------
# Step 2/3: depth, node, frame, shadow-root, and response limits
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_very_deep_dom_stops_at_the_depth_limit() -> None:
    session = FakeSession(document=deep_chain(80))

    result = await capture_page(session, CaptureLimits(max_depth=10, timeout_seconds=5))

    assert result.truncated_by_depth is True
    assert result.partial is True
    depth = 0
    current = result.root
    while current.children:
        current = current.children[0]
        depth += 1
    assert depth <= 10


@pytest.mark.asyncio
async def test_very_wide_dom_stops_at_the_node_limit_and_preserves_order() -> None:
    session = FakeSession(document=wide_cards(500))

    result = await capture_page(session, CaptureLimits(max_raw_nodes=25, timeout_seconds=5))

    assert result.truncated_by_node_limit is True
    assert result.node_count <= 25
    captured_cards = result.root.children[0].children
    assert [card.backend_node_id for card in captured_cards] == sorted(
        card.backend_node_id for card in captured_cards
    ), "document order must be preserved"


@pytest.mark.asyncio
async def test_frames_and_shadow_roots_are_counted_and_capped() -> None:
    same_origin = [
        node(
            400 + index,
            "IFRAME",
            content_document=node(
                500 + index, "#document", node_type=9, children=[node(600 + index, "P")]
            ),
        )
        for index in range(4)
    ]
    cross_origin = node(700, "IFRAME", attributes=["src", "https://other.test/widget"])
    host = node(800, "DIV", shadow_roots=[node(801, "#document-fragment", node_type=11)])
    session = FakeSession(document=node(1, "HTML", children=[*same_origin, cross_origin, host]))

    result = await capture_page(session, CaptureLimits(max_frames=2, timeout_seconds=5))

    assert result.frame_count == 2
    assert result.truncated_by_frame_limit is True
    assert result.root.children[2].inaccessible_boundary_reason == BOUNDARY_FRAME_BUDGET
    # A cross-origin frame is reported structurally, never probed.
    assert result.root.children[4].frame_boundary_reason == "cross_origin_frame"
    assert result.root.children[4].origin_hint == "https://other.test/widget"
    assert result.shadow_root_count == 1
    assert result.root.children[5].children[0].is_shadow_root is True


@pytest.mark.asyncio
async def test_shadow_root_budget_is_reported_explicitly() -> None:
    host = node(
        800,
        "DIV",
        shadow_roots=[node(810 + i, "#document-fragment", node_type=11) for i in range(5)],
    )
    session = FakeSession(document=node(1, "HTML", children=[host]))

    result = await capture_page(session, CaptureLimits(max_shadow_roots=2, timeout_seconds=5))

    assert result.shadow_root_count == 2
    assert result.truncated_by_shadow_limit is True
    assert result.root.children[0].inaccessible_boundary_reason == BOUNDARY_SHADOW_BUDGET


@pytest.mark.asyncio
async def test_one_oversized_cdp_response_is_truncated_and_reported() -> None:
    session = FakeSession(document=wide_cards(100))

    result = await capture_page(
        session,
        CaptureLimits(max_nodes_per_response=10, max_raw_nodes=10_000, timeout_seconds=5),
    )

    assert result.truncated_by_response_limit is True
    assert len(result.root.children[0].children) == 10


@pytest.mark.asyncio
async def test_malformed_nodes_do_not_abort_the_capture() -> None:
    malformed = {
        "backendNodeId": 9,
        "nodeType": 1,
        "nodeName": None,
        "nodeValue": None,
        "attributes": ["only-a-key"],
        "children": None,
        "childNodeCount": None,
        "shadowRoots": None,
    }
    session = FakeSession(document=node(1, "HTML", children=[malformed, node(2, "ARTICLE")]))

    result = await capture_page(session, CaptureLimits(timeout_seconds=5))

    assert result.node_count == 3
    assert result.root.children[0].tag == ""
    assert result.root.children[0].attributes == {}
    assert result.root.children[1].backend_node_id == 2


# --------------------------------------------------------------------------
# Step 6: cancellation during every capture phase
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "phase",
    ["DOM.getDocument", "DOM.describeNode", "Accessibility.getFullAXTree"],
)
@pytest.mark.asyncio
async def test_cancellation_during_any_capture_phase_propagates_promptly(phase: str) -> None:
    container = node(50, "SECTION", children=[], child_node_count=4)
    session = FakeSession(
        document=node(1, "HTML", children=[container]),
        expansions={50: node(50, "SECTION", children=[node(51, "P")])},
        stall=frozenset({phase}),
    )
    task = asyncio.create_task(capture_page(session, CaptureLimits(timeout_seconds=30)))
    await asyncio.sleep(0.05)
    task.cancel()
    async with asyncio.timeout(2):
        with pytest.raises(asyncio.CancelledError):
            await task


# --------------------------------------------------------------------------
# Sub-budget arithmetic (P03-R03 step 3 primitives)
# --------------------------------------------------------------------------


def test_stage_budgets_must_fit_inside_the_total() -> None:
    with pytest.raises(ValueError):
        StageBudget(
            total_seconds=10,
            navigation_seconds=5,
            settle_seconds=5,
            capture_seconds=5,
            extraction_seconds=1,
            validation_seconds=1,
            cleanup_seconds=1,
        )
    with pytest.raises(ValueError):
        StageBudget(
            total_seconds=10,
            navigation_seconds=0,
            settle_seconds=1,
            capture_seconds=1,
            extraction_seconds=1,
            validation_seconds=1,
            cleanup_seconds=1,
        )


def test_a_stage_can_never_outlive_the_total_however_much_ceiling_remains() -> None:
    clock_time = [0.0]
    budget = StageBudget(
        total_seconds=10,
        navigation_seconds=6,
        settle_seconds=1,
        capture_seconds=1,
        extraction_seconds=1,
        validation_seconds=0.5,
        cleanup_seconds=0.5,
    )
    clock = BudgetClock(budget, now=lambda: clock_time[0])

    assert clock.stage_seconds(budget.navigation_seconds) == 6
    clock_time[0] = 9.5
    # Only 0.5s of the total is left, so a 6s ceiling is clamped to it.
    assert clock.stage_seconds(budget.navigation_seconds) == pytest.approx(0.5)
    clock_time[0] = 11.0
    assert clock.exhausted() is True
    assert clock.stage_seconds(budget.capture_seconds) == 0
