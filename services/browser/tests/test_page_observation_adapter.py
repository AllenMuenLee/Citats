from __future__ import annotations

import asyncio
from types import SimpleNamespace
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
) -> Any:
    return SimpleNamespace(
        backend_node_id=backend_id,
        node_type=1,
        node_name=name,
        node_value="",
        attributes=[],
        children=children or [],
        content_document=content_document,
        shadow_roots=shadow_roots or [],
    )


class CaptureTab:
    def __init__(self, document: Any) -> None:
        self.document = document
        self.commands: list[str] = []

    async def send(self, command: Any) -> Any:
        method = str(command.gi_code.co_name)
        self.commands.append(method)
        if method == "get_document":
            return self.document
        if method == "get_full_ax_tree":
            return []
        raise AssertionError(f"unexpected command: {method}")


@pytest.mark.asyncio
async def test_capture_is_bounded_cycle_safe_and_uses_no_network_domain() -> None:
    repeated = _node(2, "DIV")
    root = _node(1, "HTML", children=[repeated, repeated, _node(3, "SPAN")])
    tab = CaptureTab(root)

    result = await capture_page(
        tab, CaptureLimits(max_raw_nodes=2, max_depth=10, timeout_seconds=1)
    )

    assert result.node_count == 2
    assert result.truncated_by_node_limit is True
    assert result.timed_out is False
    assert all("Network" not in name and "Fetch" not in name for name in tab.commands)


@pytest.mark.asyncio
async def test_capture_marks_inaccessible_boundaries_and_duplicate_references() -> None:
    frame = _node(2, "IFRAME")
    frame.attributes = ["src", "https://other.test/frame"]
    plugin = _node(3, "OBJECT")
    shared = _node(4, "BUTTON")
    root = _node(1, "HTML", children=[frame, plugin, shared, shared])

    result = await capture_page(CaptureTab(root))

    assert result.root.children[0].frame_boundary_reason == "cross_origin_frame"
    assert result.root.children[1].inaccessible_boundary_reason == "plugin_or_embedded_content"
    assert result.root.children[3].inaccessible_boundary_reason == "cycle_or_duplicate_reference"
    assert result.duplicate_or_cycle_count == 1


class SettleTab:
    def __init__(self) -> None:
        self.handlers: list[tuple[Any, Any]] = []
        self.removed: list[tuple[Any, Any]] = []

    def add_handler(self, event_type: Any, handler: Any) -> None:
        self.handlers.append((event_type, handler))

    def remove_handler(self, event_type: Any, handler: Any) -> None:
        self.removed.append((event_type, handler))

    async def send(self, _command: Any) -> None:
        return None


@pytest.mark.asyncio
async def test_settle_is_deterministically_bounded_and_cleans_up_handlers() -> None:
    tab = SettleTab()
    result = await wait_for_settle(
        tab, SettleConfig(quiet_window_seconds=0.001, max_settle_seconds=0.1)
    )

    assert result.status == "complete"
    assert len(tab.removed) == len(tab.handlers) > 0


@pytest.mark.asyncio
async def test_settle_cancellation_cleans_up_handlers() -> None:
    tab = SettleTab()
    task = asyncio.create_task(
        wait_for_settle(tab, SettleConfig(quiet_window_seconds=10, max_settle_seconds=20))
    )
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(tab.removed) == len(tab.handlers) > 0


@pytest.mark.asyncio
async def test_layout_deduplicates_requests_and_preserves_order() -> None:
    calls: list[int] = []

    class LayoutTab:
        async def send(self, command: Any) -> Any:
            request = command.send(None)
            backend_id = int(request["params"]["backendNodeId"])
            calls.append(backend_id)
            return SimpleNamespace(content=[0, 0, 10, 0, 10, 5, 0, 5])

    boxes = await fetch_bounding_boxes(LayoutTab(), [2, 1, 2])
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
