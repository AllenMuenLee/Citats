"""Cancellation-safe wall-clock bounds around individual CDP requests
(P03-R02 step 1).

Every awaited CDP request in the observation path goes through
:func:`send_bounded`. Before this existed, ``capture_page`` computed a
"deadline" and then awaited an unlimited ``DOM.getDocument`` and an
unlimited ``Accessibility.getFullAXTree`` *before* that deadline could
influence anything -- the bound applied only to the pure-Python reduction
that ran once the whole response had already arrived. On a large
client-rendered page the awaits themselves are the stall, so a deadline
that begins after they return is not a bound at all.

:func:`send_bounded` therefore wraps the await itself, and
:class:`StageBudget` carves one total budget into named sub-budgets so
sequential stages cannot each consume the whole total independently
(P03-R03 step 3).
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

from nodriver.core.tab import Tab  # type: ignore[import-untyped]

#: Never issue a request with a non-positive or vanishing budget -- a
#: zero-length ``asyncio.timeout`` window races the event loop and reports a
#: timeout for work that was never actually attempted.
MIN_REQUEST_SECONDS = 0.05


class CdpTimeoutError(TimeoutError):
    """One awaited CDP request exceeded its own wall-clock budget.

    Carries the phase name rather than the command, so callers can report
    and log *where* the budget was exhausted without ever putting CDP
    primitives or page-derived values into a message.
    """

    def __init__(self, phase: str, timeout_seconds: float) -> None:
        super().__init__(f"CDP request '{phase}' exceeded {timeout_seconds:.3f}s")
        self.phase = phase
        self.timeout_seconds = timeout_seconds


async def send_bounded(
    page: Tab,
    command: Any,
    *,
    timeout_seconds: float,
    phase: str,
) -> Any:
    """Awaits one CDP command under a hard wall-clock bound.

    Raises :class:`CdpTimeoutError` when the budget is exhausted. The
    command coroutine is cancelled on the way out, which is what stops a
    stalled request from holding the observation open; retiring whatever
    the connection has left behind is the lifecycle manager's job
    (P03-R05), not this helper's.
    """
    if timeout_seconds < MIN_REQUEST_SECONDS:
        raise CdpTimeoutError(phase, timeout_seconds)
    try:
        async with asyncio.timeout(timeout_seconds):
            return await page.send(command)
    except TimeoutError as exc:
        # `asyncio.timeout` raises bare TimeoutError; re-raise as the typed
        # phase-carrying form. A CdpTimeoutError from a nested call is
        # already typed and passes through unchanged.
        if isinstance(exc, CdpTimeoutError):
            raise
        raise CdpTimeoutError(phase, timeout_seconds) from exc


@dataclass(frozen=True)
class StageBudget:
    """A total wall-clock budget divided into named sequential stages.

    Sub-budgets are *ceilings*, not reservations: a stage may never exceed
    its own ceiling, and no stage may run past the total deadline however
    much of its own ceiling remains. Time a stage does not use stays
    available to later stages, which is what lets a fast navigation leave
    more room for a slow capture without letting a slow navigation starve
    everything after it.
    """

    total_seconds: float
    navigation_seconds: float
    settle_seconds: float
    capture_seconds: float
    extraction_seconds: float
    validation_seconds: float
    cleanup_seconds: float

    def __post_init__(self) -> None:
        stages = (
            self.navigation_seconds,
            self.settle_seconds,
            self.capture_seconds,
            self.extraction_seconds,
            self.validation_seconds,
            self.cleanup_seconds,
        )
        if any(stage <= 0 for stage in stages) or self.total_seconds <= 0:
            raise ValueError("Every exploration budget must be positive.")
        if sum(stages) > self.total_seconds:
            raise ValueError("Exploration sub-budgets must fit inside the total budget.")


class BudgetClock:
    """Tracks remaining time against one :class:`StageBudget`."""

    def __init__(self, budget: StageBudget, *, now: Any = time.monotonic) -> None:
        self._budget = budget
        self._now = now
        self._started_at = now()

    @property
    def budget(self) -> StageBudget:
        return self._budget

    @property
    def elapsed_seconds(self) -> float:
        return float(self._now() - self._started_at)

    @property
    def total_remaining_seconds(self) -> float:
        return max(0.0, self._budget.total_seconds - self.elapsed_seconds)

    def stage_seconds(self, stage_ceiling_seconds: float) -> float:
        """The budget one stage may actually use right now: its own ceiling,
        clamped to whatever remains of the total."""
        return max(0.0, min(stage_ceiling_seconds, self.total_remaining_seconds))

    def exhausted(self) -> bool:
        return self.total_remaining_seconds <= 0.0


__all__ = [
    "MIN_REQUEST_SECONDS",
    "BudgetClock",
    "CdpTimeoutError",
    "StageBudget",
    "send_bounded",
]
