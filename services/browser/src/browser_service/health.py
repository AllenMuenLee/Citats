"""Dependency reachability checks used by the readiness endpoint.

Phase 0 only proves TCP reachability of Postgres and Redis using
env-var-configured host/port pairs (see `config.py`). It does not
authenticate, run a query, or hold a pooled connection -- that belongs to
whichever later feature actually integrates with these stores. This keeps
the readiness check dependency-light (no DB driver required) while still
being a real, non-trivial check rather than a hardcoded value.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Literal

from browser_service.config import DependencyTarget

ComponentStatus = Literal["up", "down", "unknown"]

_CONNECT_TIMEOUT_SECONDS = 1.5


async def check_tcp_reachable(target: DependencyTarget) -> ComponentStatus:
    """Return "up" if a TCP connection to the target succeeds, else "down".

    Returns "unknown" if the target is not configured (host/port missing),
    since we cannot meaningfully report up/down for an unconfigured
    dependency.
    """
    if not target.configured:
        return "unknown"

    assert target.host is not None
    assert target.port is not None

    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(target.host, target.port),
            timeout=_CONNECT_TIMEOUT_SECONDS,
        )
    except (OSError, TimeoutError):
        return "down"

    writer.close()
    with contextlib.suppress(OSError):
        await writer.wait_closed()

    return "up"
