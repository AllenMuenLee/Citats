"""Bounded, deterministic settle strategy (P03-F01 step 2).

Waits for a quiet window of DOM mutation activity via the CDP DOM domain's
own mutation events -- never by evaluating page-authored script, and never
by waiting indefinitely. Reports one of `complete`/`timeout`/`unstable`
rather than silently guessing that a page has finished rendering.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from dataclasses import dataclass

from nodriver.cdp import dom as cdp_dom
from nodriver.core.tab import Tab  # type: ignore[import-untyped]

DEFAULT_QUIET_WINDOW_SECONDS = 0.5
DEFAULT_MAX_SETTLE_SECONDS = 8.0
DEFAULT_MAX_MUTATION_EVENTS = 4_000


@dataclass(frozen=True)
class SettleConfig:
    quiet_window_seconds: float = DEFAULT_QUIET_WINDOW_SECONDS
    max_settle_seconds: float = DEFAULT_MAX_SETTLE_SECONDS
    max_mutation_events: int = DEFAULT_MAX_MUTATION_EVENTS


@dataclass(frozen=True)
class SettleResult:
    """`status` mirrors `ObservationStatusSchema`: `complete` (a quiet
    window was reached before the settle budget ran out), `timeout` (the
    settle budget ran out first), or `unstable` (mutation volume exceeded
    `max_mutation_events`, i.e. the page kept changing too fast/too much to
    ever consider settled)."""

    status: str
    elapsed_seconds: float
    mutation_count: int


_MUTATION_EVENT_TYPES = (
    cdp_dom.ChildNodeInserted,
    cdp_dom.ChildNodeRemoved,
    cdp_dom.AttributeModified,
    cdp_dom.AttributeRemoved,
    cdp_dom.CharacterDataModified,
    cdp_dom.DocumentUpdated,
)


async def wait_for_settle(page: Tab, config: SettleConfig | None = None) -> SettleResult:
    """Enables the DOM domain, counts mutation events, and waits for a
    quiet window -- a period with no mutation events -- of
    `quiet_window_seconds`, bounded overall by `max_settle_seconds`.
    Always disables mutation event delivery again before returning.
    """
    cfg = config if config is not None else SettleConfig()
    start = time.monotonic()
    mutation_count = 0
    last_activity = start

    def on_mutation(_event: object, _tab: Tab) -> None:
        nonlocal mutation_count, last_activity
        mutation_count += 1
        last_activity = time.monotonic()

    for event_type in _MUTATION_EVENT_TYPES:
        page.add_handler(event_type, on_mutation)
    try:
        await page.send(cdp_dom.enable())
        while True:
            now = time.monotonic()
            elapsed = now - start
            if elapsed >= cfg.max_settle_seconds:
                return SettleResult("timeout", elapsed, mutation_count)
            if mutation_count > cfg.max_mutation_events:
                return SettleResult("unstable", elapsed, mutation_count)
            since_activity = now - last_activity
            if since_activity >= cfg.quiet_window_seconds:
                return SettleResult("complete", elapsed, mutation_count)
            await asyncio.sleep(min(cfg.quiet_window_seconds - since_activity, 0.1))
    finally:
        for event_type in _MUTATION_EVENT_TYPES:
            with contextlib.suppress(Exception):
                page.remove_handler(event_type, on_mutation)


__all__ = [
    "DEFAULT_MAX_SETTLE_SECONDS",
    "DEFAULT_QUIET_WINDOW_SECONDS",
    "SettleConfig",
    "SettleResult",
    "wait_for_settle",
]
