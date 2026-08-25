"""Tool registry: maps a tool name to its invocation model and async handler.

Every handler has the signature ``(invocation, cancelled) -> ToolHandlerOutcome``
(raising :class:`~browser_service.tool_outcome.ToolExecutionError` for any
expected, safe-to-surface failure) -- `api/bridge.py` is generic over this
shape and never hardcodes a tool-specific payload/result structure.

This registry is closed and read-only: it exposes exactly the tools
listed here (`system.echo` -- the P00 reference/test tool;
`browser.navigate_and_extract` -- P02-F04). Nothing here (or anywhere
reachable from it) exposes click, form, script-evaluation, or other
mutation capability.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any

from browser_service.contracts import (
    InvocationExploreWebsite,
    InvocationGetPageUnderstandingSlice,
    InvocationNavigateAndExtract,
    InvocationProposeGenerativeUiPlan,
    InvocationSystemEcho,
    SuccessResultExploreWebsite,
    SuccessResultGetPageUnderstandingSlice,
    SuccessResultNavigateAndExtract,
    SuccessResultProposeGenerativeUiPlan,
    SuccessResultSystemEcho,
)
from browser_service.tool_outcome import ToolHandlerOutcome
from browser_service.tools.explore_website import run_explore_website
from browser_service.tools.get_page_understanding_slice import run_get_page_understanding_slice
from browser_service.tools.navigate_and_extract import run_navigate_and_extract
from browser_service.tools.propose_generative_ui_plan import run_propose_generative_ui_plan

MAX_ARTIFICIAL_DELAY_MS = 2_000

ToolHandler = Callable[[Any, asyncio.Event], Coroutine[Any, Any, ToolHandlerOutcome]]


async def system_echo(
    invocation: InvocationSystemEcho, cancelled: asyncio.Event
) -> ToolHandlerOutcome:
    """Echo the bounded message, with an optional test-only bounded delay."""
    delay_value = (invocation.arguments.context or {}).get("delayMs", 0)
    delay_ms = (
        delay_value if isinstance(delay_value, int) and not isinstance(delay_value, bool) else 0
    )
    delay_ms = min(max(delay_ms, 0), MAX_ARTIFICIAL_DELAY_MS)
    if delay_ms:
        try:
            await asyncio.wait_for(cancelled.wait(), timeout=delay_ms / 1_000)
            raise asyncio.CancelledError
        except TimeoutError:
            pass
    if cancelled.is_set():
        raise asyncio.CancelledError
    return ToolHandlerOutcome(payload={"message": invocation.arguments.message})


@dataclass(frozen=True)
class ToolRegistration:
    """One tool's invocation model, handler, default sensitivity, and the
    success-result model its assembled response is validated against
    before being returned -- a safety net against a handler's payload
    silently drifting from its own declared contract."""

    invocation_model: type[Any]
    handler: ToolHandler
    success_model: type[Any]
    sensitive: bool = False


TOOL_REGISTRY: dict[str, ToolRegistration] = {
    "system.echo": ToolRegistration(InvocationSystemEcho, system_echo, SuccessResultSystemEcho),
    "browser.navigate_and_extract": ToolRegistration(
        InvocationNavigateAndExtract, run_navigate_and_extract, SuccessResultNavigateAndExtract
    ),
    "browser.explore_website": ToolRegistration(
        InvocationExploreWebsite, run_explore_website, SuccessResultExploreWebsite
    ),
    "browser.get_page_understanding_slice": ToolRegistration(
        InvocationGetPageUnderstandingSlice,
        run_get_page_understanding_slice,
        SuccessResultGetPageUnderstandingSlice,
    ),
    "ui.propose_generative_ui_plan": ToolRegistration(
        InvocationProposeGenerativeUiPlan,
        run_propose_generative_ui_plan,
        SuccessResultProposeGenerativeUiPlan,
    ),
}
