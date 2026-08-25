"""Bounded viewport-relative bounding boxes (P03-F01 step 5, mission item
13). Only fetched for nodes that already made it into the bounded emitted
node set -- never for the full raw DOM -- and only via `DOM.getBoxModel`,
never a full computed-style dump.
"""

from __future__ import annotations

import asyncio
import contextlib

from nodriver.cdp import dom as cdp_dom
from nodriver.core.tab import Tab  # type: ignore[import-untyped]

MAX_CONCURRENT_BOX_MODEL_FETCHES = 12


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


async def fetch_bounding_boxes(
    page: Tab, backend_node_ids: list[int]
) -> dict[int, dict[str, float] | None]:
    """Returns a bounding box (or `None`, when the node has no box -- e.g.
    detached, `display: none`) per requested `backendNodeId`, fetched
    concurrently with a bounded fan-out."""
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_BOX_MODEL_FETCHES)
    results: dict[int, dict[str, float] | None] = {}
    unique_node_ids = list(dict.fromkeys(backend_node_ids))

    async def fetch_one(backend_node_id: int) -> None:
        async with semaphore:
            box: dict[str, float] | None = None
            with contextlib.suppress(Exception):
                model = await page.send(
                    cdp_dom.get_box_model(
                        backend_node_id=cdp_dom.BackendNodeId(backend_node_id)
                    )
                )
                box = _box_from_quad(list(model.content))
            results[backend_node_id] = box

    await asyncio.gather(*(fetch_one(node_id) for node_id in unique_node_ids))
    return {node_id: results[node_id] for node_id in unique_node_ids}


__all__ = ["fetch_bounding_boxes"]
