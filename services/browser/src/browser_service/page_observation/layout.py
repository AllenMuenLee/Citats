"""Bounded viewport-relative bounding boxes (P03-F01 step 5, mission item
13; bounded per-request by P03-R02 step 1).

Only fetched for nodes that already made it into the bounded emitted node
set -- never for the full raw DOM -- and only via `DOM.getBoxModel`, never a
full computed-style dump.

Each `getBoxModel` is a separate CDP round trip, so on a results page with
two thousand emitted nodes this stage is two thousand awaits. Previously
none of them carried a bound and the whole stage carried no deadline
either, which made it one of the two places a large page could stall
indefinitely. Both bounds now exist, and a stage that runs out of budget
reports how many nodes it never measured instead of silently returning
`None` for them (which the graph would read as "this node has no box").
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

from browser_service.page_observation.cdp import CdpSession, CdpTimeoutError, send_bounded

MAX_CONCURRENT_BOX_MODEL_FETCHES = 12
DEFAULT_LAYOUT_BUDGET_SECONDS = 5.0
DEFAULT_BOX_REQUEST_TIMEOUT_SECONDS = 1.0


@dataclass(frozen=True)
class BoundingBoxCapture:
    """Boxes plus the coverage accounting the observation needs to describe
    itself honestly."""

    boxes: dict[int, dict[str, float] | None] = field(default_factory=dict)
    #: Nodes for which a box model request actually completed.
    measured_count: int = 0
    #: Nodes never asked about because the stage budget ran out first.
    skipped_count: int = 0
    timed_out: bool = False


def _box_from_quad(quad: list[float]) -> dict[str, float] | None:
    """`BoxModel.content` is an 8-number quad (x1,y1,x2,y2,x3,y3,x4,y4) --
    reduced to an axis-aligned bounding box."""
    if len(quad) < 8:
        return None
    xs = quad[0::2]
    ys = quad[1::2]
    x, y = min(xs), min(ys)
    width, height = max(xs) - x, max(ys) - y
    return {"x": x, "y": y, "width": max(width, 0.0), "height": max(height, 0.0)}


async def capture_bounding_boxes(
    session: CdpSession,
    backend_node_ids: list[int],
    *,
    budget_seconds: float = DEFAULT_LAYOUT_BUDGET_SECONDS,
    request_timeout_seconds: float = DEFAULT_BOX_REQUEST_TIMEOUT_SECONDS,
) -> BoundingBoxCapture:
    """Fetches one bounding box per requested `backendNodeId` with a bounded
    fan-out, a per-request wall-clock bound, and a stage deadline.

    Nodes not reached before the deadline are reported through
    `skipped_count` and are absent from `boxes`, which is what lets the
    caller distinguish "measured, has no box" from "never measured".
    """
    deadline = time.monotonic() + budget_seconds
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_BOX_MODEL_FETCHES)
    results: dict[int, dict[str, float] | None] = {}
    unique_node_ids = list(dict.fromkeys(backend_node_ids))
    timed_out = False

    async def fetch_one(backend_node_id: int) -> None:
        nonlocal timed_out
        async with semaphore:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                return
            box: dict[str, float] | None = None
            try:
                model = await send_bounded(
                    session,
                    "DOM.getBoxModel",
                    {"backendNodeId": backend_node_id},
                    timeout_seconds=min(request_timeout_seconds, remaining),
                    phase="dom.get_box_model",
                )
                box = _box_from_quad(list(model["model"]["content"]))
            except CdpTimeoutError:
                timed_out = True
                return
            except Exception:  # noqa: BLE001 -- a node with no box is normal, not a failure
                box = None
            results[backend_node_id] = box

    await asyncio.gather(*(fetch_one(node_id) for node_id in unique_node_ids))

    ordered = {node_id: results[node_id] for node_id in unique_node_ids if node_id in results}
    return BoundingBoxCapture(
        boxes=ordered,
        measured_count=len(ordered),
        skipped_count=len(unique_node_ids) - len(ordered),
        timed_out=timed_out,
    )


async def fetch_bounding_boxes(
    session: CdpSession, backend_node_ids: list[int]
) -> dict[int, dict[str, float] | None]:
    """Boxes only, for callers that do not report coverage themselves."""
    captured = await capture_bounding_boxes(session, backend_node_ids)
    return captured.boxes


__all__ = ["BoundingBoxCapture", "capture_bounding_boxes", "fetch_bounding_boxes"]
