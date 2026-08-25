"""Owned, bounded continuation slices for page-understanding graphs."""

from __future__ import annotations

import asyncio

from browser_service.contracts import InvocationGetPageUnderstandingSlice
from browser_service.tool_outcome import ToolHandlerOutcome
from browser_service.tools.explore_website import OBSERVATIONS

MAX_NODES = 100
MAX_RELATIONSHIPS = 200


async def run_get_page_understanding_slice(
    invocation: InvocationGetPageUnderstandingSlice, cancelled: asyncio.Event
) -> ToolHandlerOutcome:
    if cancelled.is_set():
        raise asyncio.CancelledError
    found = OBSERVATIONS.get_slice(
        observation_id=invocation.arguments.observationId,
        handle=invocation.arguments.handle,
        session_id=invocation.correlation.sessionId or "",
        owner_id=invocation.correlation.userId,
    )
    if found is None:
        payload = {
            "found": False,
            "nodes": [],
            "relationships": [],
            "truncated": False,
            "warnings": [
                {
                    "code": "handle_expired",
                    "message": (
                        "The observation is unavailable, expired, or not owned by this session."
                    ),
                    "nodeHandle": None,
                }
            ],
            "untrusted": True,
        }
    else:
        nodes, relationships, handle_found = found
        truncated = len(nodes) > MAX_NODES or len(relationships) > MAX_RELATIONSHIPS
        payload = {
            "found": handle_found,
            "nodes": nodes[:MAX_NODES],
            "relationships": relationships[:MAX_RELATIONSHIPS],
            "truncated": truncated,
            "warnings": []
            if handle_found
            else [
                {
                    "code": "handle_not_found",
                    "message": "The handle is not part of this observation.",
                    "nodeHandle": None,
                }
            ],
            "untrusted": True,
        }
    return ToolHandlerOutcome(payload=payload)


__all__ = ["run_get_page_understanding_slice"]
