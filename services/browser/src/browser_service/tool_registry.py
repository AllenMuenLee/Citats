"""Closed Phase-0 tool registry. No browsing implementation lives here."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any

from browser_service.contracts.generated.invocation_system_echo import InvocationSystemEcho

ToolHandler = Callable[[InvocationSystemEcho, asyncio.Event], Coroutine[Any, Any, str]]
MAX_ARTIFICIAL_DELAY_MS = 2_000


async def system_echo(invocation: InvocationSystemEcho, cancelled: asyncio.Event) -> str:
    """Echo the bounded message, with an optional test-only bounded delay."""
    delay_value = (invocation.arguments.context or {}).get("delayMs", 0)
    delay_ms = (
        delay_value
        if isinstance(delay_value, int) and not isinstance(delay_value, bool)
        else 0
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
    return invocation.arguments.message


TOOL_REGISTRY: dict[str, ToolHandler] = {"system.echo": system_echo}
