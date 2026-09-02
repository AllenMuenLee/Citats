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

from browser_service.page_observation.cdp import CdpSession, CdpTimeoutError, send_bounded

DEFAULT_QUIET_WINDOW_SECONDS = 0.5
DEFAULT_MAX_SETTLE_SECONDS = 8.0
#: A client-rendered page is briefly, genuinely quiet between
#: `DOMContentLoaded` and the moment its own scripts start building the DOM.
#: Reproduced on a large accommodation search page: settle reported
#: `complete` after ~0.7s, capture then observed zero nodes, and the whole
#: observation returned an empty graph for a page that renders a full result
#: list a few seconds later. A quiet window is therefore not accepted before
#: this floor has elapsed -- it costs a fixed sub-second wait on a page that
#: really was already done, and is the difference between an empty
#: observation and a usable one on a page that was not.
DEFAULT_MIN_SETTLE_SECONDS = 1.5
DEFAULT_MAX_MUTATION_EVENTS = 4_000
DEFAULT_ENABLE_TIMEOUT_SECONDS = 2.0


@dataclass(frozen=True)
class SettleConfig:
    quiet_window_seconds: float = DEFAULT_QUIET_WINDOW_SECONDS
    max_settle_seconds: float = DEFAULT_MAX_SETTLE_SECONDS
    #: Floor before a quiet window may be accepted -- see
    #: :data:`DEFAULT_MIN_SETTLE_SECONDS`. Clamped to half of
    #: `max_settle_seconds` so a caller that shortens the budget can never
    #: make the floor unreachable.
    min_settle_seconds: float = DEFAULT_MIN_SETTLE_SECONDS
    max_mutation_events: int = DEFAULT_MAX_MUTATION_EVENTS
    #: Wall-clock bound on `DOM.enable` itself (P03-R02 step 1). Enabling the
    #: domain is an awaited CDP round trip like any other, and an unbounded
    #: one here would stall before the settle loop's own clock ever started.
    enable_timeout_seconds: float = DEFAULT_ENABLE_TIMEOUT_SECONDS


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
    #: Whether mutation events were ever enabled. When `DOM.enable` itself
    #: exceeded its bound the settle result is honest about having observed
    #: nothing, rather than reporting a quiet page.
    events_enabled: bool = True


#: CDP event names, not driver objects -- the session this subscribes on is a
#: raw CDP transport (see `page_observation/cdp.py`).
_MUTATION_EVENT_TYPES = (
    "DOM.childNodeInserted",
    "DOM.childNodeRemoved",
    "DOM.attributeModified",
    "DOM.attributeRemoved",
    "DOM.characterDataModified",
    "DOM.documentUpdated",
)


async def wait_for_settle(
    session: CdpSession, config: SettleConfig | None = None
) -> SettleResult:
    """Enables the DOM domain, counts mutation events, and waits for a
    quiet window -- a period with no mutation events -- of
    `quiet_window_seconds`, bounded overall by `max_settle_seconds`.
    Always disables mutation event delivery again before returning.
    """
    cfg = config if config is not None else SettleConfig()
    start = time.monotonic()
    mutation_count = 0
    last_activity = start

    def on_mutation(_event: object = None) -> None:
        nonlocal mutation_count, last_activity
        mutation_count += 1
        last_activity = time.monotonic()

    for event_type in _MUTATION_EVENT_TYPES:
        session.on(event_type, on_mutation)
    try:
        try:
            await send_bounded(
                session,
                "DOM.enable",
                timeout_seconds=min(cfg.enable_timeout_seconds, cfg.max_settle_seconds),
                phase="dom.enable",
            )
        except CdpTimeoutError:
            # No mutation stream, so no quiet window can be observed. Report
            # `timeout` rather than waiting out a budget that cannot succeed.
            return SettleResult("timeout", time.monotonic() - start, 0, events_enabled=False)
        while True:
            now = time.monotonic()
            elapsed = now - start
            if elapsed >= cfg.max_settle_seconds:
                return SettleResult("timeout", elapsed, mutation_count)
            if mutation_count > cfg.max_mutation_events:
                return SettleResult("unstable", elapsed, mutation_count)
            since_activity = now - last_activity
            # Half the budget, never the whole of it: a floor equal to
            # `max_settle_seconds` could never be reached in time, which would
            # turn every settle into a `timeout` on a caller that shortened
            # the budget.
            floor = min(cfg.min_settle_seconds, cfg.max_settle_seconds / 2)
            if since_activity >= cfg.quiet_window_seconds and elapsed >= floor:
                return SettleResult("complete", elapsed, mutation_count)
            # Sleep until whichever unmet condition is closest, capped so a
            # mutation arriving mid-sleep is still noticed promptly, and
            # floored so a satisfied quiet window cannot spin the loop while
            # the minimum-settle floor runs down.
            await asyncio.sleep(
                min(
                    max(
                        cfg.quiet_window_seconds - since_activity,
                        floor - elapsed,
                        0.01,
                    ),
                    0.1,
                )
            )
    finally:
        for event_type in _MUTATION_EVENT_TYPES:
            with contextlib.suppress(Exception):
                session.remove_listener(event_type, on_mutation)


__all__ = [
    "DEFAULT_MAX_SETTLE_SECONDS",
    "DEFAULT_MIN_SETTLE_SECONDS",
    "DEFAULT_QUIET_WINDOW_SECONDS",
    "SettleConfig",
    "SettleResult",
    "wait_for_settle",
]
