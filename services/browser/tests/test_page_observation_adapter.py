from __future__ import annotations

import asyncio
from typing import Any

import pytest

from browser_service.page_observation.capture import CaptureLimits, capture_page
from browser_service.page_observation.handles import (
    HandleMinter,
    ObservationStore,
    StoredObservation,
)
from browser_service.page_observation.layout import fetch_bounding_boxes
from browser_service.page_observation.settle import SettleConfig, wait_for_settle


def _node(
    backend_id: int,
    name: str,
    *,
    children: list[Any] | None = None,
    content_document: Any = None,
    shadow_roots: list[Any] | None = None,
) -> dict[str, Any]:
    """One ``DOM.Node`` exactly as CDP puts it on the wire."""
    node: dict[str, Any] = {
        "backendNodeId": backend_id,
        "nodeType": 1,
        "nodeName": name,
        "nodeValue": "",
        "attributes": [],
        "children": children or [],
        "shadowRoots": shadow_roots or [],
    }
    if content_document is not None:
        node["contentDocument"] = content_document
    return node


class CaptureSession:
    """Fake CDP session: answers by method name, records what was asked."""

    def __init__(self, document: Any) -> None:
        self.document = document
        self.commands: list[str] = []

    async def send(self, method: str, params: dict[str, Any] | None = None) -> Any:
        self.commands.append(method)
        if method == "DOM.getDocument":
            return {"root": self.document}
        if method == "Accessibility.getFullAXTree":
            return {"nodes": []}
        raise AssertionError(f"unexpected command: {method}")

    def on(self, event: str, handler: Any) -> None:
        raise AssertionError("capture must not subscribe to events")

    def remove_listener(self, event: str, handler: Any) -> None:
        raise AssertionError("capture must not subscribe to events")


@pytest.mark.asyncio
async def test_capture_is_bounded_cycle_safe_and_uses_no_network_domain() -> None:
    repeated = _node(2, "DIV")
    root = _node(1, "HTML", children=[repeated, repeated, _node(3, "SPAN")])
    session = CaptureSession(root)

    result = await capture_page(
        session, CaptureLimits(max_raw_nodes=2, max_depth=10, timeout_seconds=1)
    )

    assert result.node_count == 2
    assert result.truncated_by_node_limit is True
    assert result.timed_out is False
    assert all("Network" not in name and "Fetch" not in name for name in session.commands)


@pytest.mark.asyncio
async def test_capture_marks_inaccessible_boundaries_and_duplicate_references() -> None:
    frame = _node(2, "IFRAME")
    frame["attributes"] = ["src", "https://other.test/frame"]
    plugin = _node(3, "OBJECT")
    shared = _node(4, "BUTTON")
    root = _node(1, "HTML", children=[frame, plugin, shared, shared])

    result = await capture_page(CaptureSession(root))

    assert result.root.children[0].frame_boundary_reason == "cross_origin_frame"
    assert result.root.children[1].inaccessible_boundary_reason == "plugin_or_embedded_content"
    assert result.root.children[3].inaccessible_boundary_reason == "cycle_or_duplicate_reference"
    assert result.duplicate_or_cycle_count == 1


class SettleSession:
    def __init__(self) -> None:
        self.handlers: list[tuple[Any, Any]] = []
        self.removed: list[tuple[Any, Any]] = []

    def on(self, event: str, handler: Any) -> None:
        self.handlers.append((event, handler))

    def remove_listener(self, event: str, handler: Any) -> None:
        self.removed.append((event, handler))

    async def send(self, method: str, params: dict[str, Any] | None = None) -> Any:
        return {}


@pytest.mark.asyncio
async def test_settle_is_deterministically_bounded_and_cleans_up_handlers() -> None:
    session = SettleSession()
    result = await wait_for_settle(
        session, SettleConfig(quiet_window_seconds=0.001, max_settle_seconds=0.1)
    )

    assert result.status == "complete"
    assert len(session.removed) == len(session.handlers) > 0


@pytest.mark.asyncio
async def test_settle_cancellation_cleans_up_handlers() -> None:
    session = SettleSession()
    task = asyncio.create_task(
        wait_for_settle(session, SettleConfig(quiet_window_seconds=10, max_settle_seconds=20))
    )
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(session.removed) == len(session.handlers) > 0


@pytest.mark.asyncio
async def test_layout_deduplicates_requests_and_preserves_order() -> None:
    calls: list[int] = []

    class LayoutSession:
        async def send(self, method: str, params: dict[str, Any] | None = None) -> Any:
            assert method == "DOM.getBoxModel"
            calls.append(int((params or {})["backendNodeId"]))
            return {"model": {"content": [0, 0, 10, 0, 10, 5, 0, 5]}}

        def on(self, event: str, handler: Any) -> None:
            raise AssertionError("layout must not subscribe to events")

        def remove_listener(self, event: str, handler: Any) -> None:
            raise AssertionError("layout must not subscribe to events")

    boxes = await fetch_bounding_boxes(LayoutSession(), [2, 1, 2])
    assert list(boxes) == [2, 1]
    assert sorted(calls) == [1, 2]
    assert boxes[2] == {"x": 0, "y": 0, "width": 10, "height": 5}


def test_handles_are_opaque_unique_and_store_is_owner_scoped() -> None:
    minter = HandleMinter("node")
    first, second = minter.mint(), minter.mint()
    assert first != second
    assert len(first.removeprefix("node-")) >= 20

    store = ObservationStore(max_entries=1)
    stored = StoredObservation("obs", "session", "owner", {first: {"id": first}}, {}, {}, {})
    store.put(stored)
    store.put(stored)
    assert store.get_slice(
        observation_id="obs", handle=first, session_id="session", owner_id="other"
    ) is None
    assert store.get_slice(
        observation_id="obs", handle=first, session_id="session", owner_id="owner"
    ) == ([{"id": first}], [], True)
