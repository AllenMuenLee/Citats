"""Server-side validation boundary for declarative Phase 3 UI plans."""

from __future__ import annotations

import asyncio

from browser_service.contracts import InvocationProposeGenerativeUiPlan
from browser_service.tool_outcome import ToolHandlerOutcome
from browser_service.tools.explore_website import OBSERVATIONS


async def run_propose_generative_ui_plan(
    invocation: InvocationProposeGenerativeUiPlan, cancelled: asyncio.Event
) -> ToolHandlerOutcome:
    if cancelled.is_set():
        raise asyncio.CancelledError
    args = invocation.arguments
    handles = list(args.sourceCollectionHandles) + list(args.detailRegionHandles)
    accepted = bool(handles)
    for handle in handles:
        lookup = OBSERVATIONS.get_slice(
            observation_id=args.observationId,
            handle=str(handle),
            session_id=invocation.correlation.sessionId or "",
            owner_id=invocation.correlation.userId,
        )
        if lookup is None or not lookup[2]:
            accepted = False
            break
    fallback = (
        "generic_collection"
        if accepted and args.layoutKind == "generic_collection"
        else "cited_text"
    )
    reason = (
        "The declarative plan was validated; no Phase 4 presentation component is registered yet."
        if accepted
        else "The plan referenced an unavailable or unowned observation handle."
    )
    return ToolHandlerOutcome(
        payload={"accepted": accepted, "rendered": False, "fallback": fallback, "reason": reason}
    )


__all__ = ["run_propose_generative_ui_plan"]
