"""Cancellation-safe wall-clock bounds around individual CDP requests
(P03-R02 step 1), plus attribute views over raw CDP JSON.

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

**Attribute views.** The driver underneath this service is Playwright, whose
``CDPSession.send`` returns plain JSON dicts with the wire's ``camelCase``
keys. The observation pipeline was written against a typed CDP object model
with ``snake_case`` attributes, and that reduction logic -- the budgets, the
frontier, the boundary reasons -- is worth keeping exactly as it is. So the
JSON is wrapped here in thin read-only views (:class:`CdpNode`,
:class:`CdpAxNode`) that present the attributes the pipeline already reads,
rather than rewriting the pipeline around dict subscripts. The views are the
only place the wire format is known.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

#: Never issue a request with a non-positive or vanishing budget -- a
#: zero-length ``asyncio.timeout`` window races the event loop and reports a
#: timeout for work that was never actually attempted.
MIN_REQUEST_SECONDS = 0.05


class CdpSession(Protocol):
    """The one capability the observation path needs from a CDP transport.

    Satisfied by Playwright's ``CDPSession`` and by the test fakes, so
    neither this module nor anything above it imports a driver.
    """

    async def send(
        self, method: str, params: dict[Any, Any] | None = None
    ) -> dict[Any, Any]: ...

    def on(self, event: str, handler: Any) -> Any:
        """Subscribe to a raw CDP event by name (e.g. ``DOM.childNodeInserted``)."""
        ...

    def remove_listener(self, event: str, handler: Any) -> Any:
        """Unsubscribe a handler registered with :meth:`on`."""
        ...


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
    session: CdpSession,
    method: str,
    params: Mapping[str, Any] | None = None,
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
            return await session.send(method, dict(params) if params else None)
    except TimeoutError as exc:
        # `asyncio.timeout` raises bare TimeoutError; re-raise as the typed
        # phase-carrying form. A CdpTimeoutError from a nested call is
        # already typed and passes through unchanged.
        if isinstance(exc, CdpTimeoutError):
            raise
        raise CdpTimeoutError(phase, timeout_seconds) from exc


class CdpNode:
    """Read-only attribute view over one ``DOM.Node`` JSON object.

    Presents the ``snake_case`` attributes the capture pipeline reads.
    Absent keys read as ``None``/empty rather than raising, which matches
    how CDP actually omits fields (``childNodeCount`` on a text node,
    ``contentDocument`` on a cross-origin iframe).
    """

    __slots__ = ("raw",)

    def __init__(self, raw: Mapping[str, Any]) -> None:
        self.raw = raw

    @property
    def node_name(self) -> str:
        return str(self.raw.get("nodeName") or "")

    @property
    def node_type(self) -> int:
        value = self.raw.get("nodeType")
        return int(value) if isinstance(value, int) else 0

    @property
    def node_value(self) -> str | None:
        value = self.raw.get("nodeValue")
        return value if isinstance(value, str) else None

    @property
    def node_id(self) -> int:
        value = self.raw.get("nodeId")
        return int(value) if isinstance(value, int) else 0

    @property
    def backend_node_id(self) -> int:
        value = self.raw.get("backendNodeId")
        return int(value) if isinstance(value, int) else 0

    @property
    def attributes(self) -> list[str] | None:
        value = self.raw.get("attributes")
        return [str(item) for item in value] if isinstance(value, Sequence) else None

    @property
    def child_node_count(self) -> int | None:
        value = self.raw.get("childNodeCount")
        return int(value) if isinstance(value, int) else None

    @property
    def children(self) -> list[CdpNode] | None:
        return _wrap_nodes(self.raw.get("children"))

    @property
    def shadow_roots(self) -> list[CdpNode] | None:
        return _wrap_nodes(self.raw.get("shadowRoots"))

    @property
    def content_document(self) -> CdpNode | None:
        value = self.raw.get("contentDocument")
        return CdpNode(value) if isinstance(value, Mapping) else None


def _wrap_nodes(value: Any) -> list[CdpNode] | None:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return None
    return [CdpNode(item) for item in value if isinstance(item, Mapping)]


class CdpAxValue:
    """Read-only view over an ``Accessibility.AXValue``."""

    __slots__ = ("raw",)

    def __init__(self, raw: Mapping[str, Any]) -> None:
        self.raw = raw

    @property
    def value(self) -> Any:
        return self.raw.get("value")


class CdpAxProperty:
    """Read-only view over an ``Accessibility.AXProperty``."""

    __slots__ = ("raw",)

    def __init__(self, raw: Mapping[str, Any]) -> None:
        self.raw = raw

    @property
    def name(self) -> str:
        return str(self.raw.get("name") or "")

    @property
    def value(self) -> CdpAxValue | None:
        value = self.raw.get("value")
        return CdpAxValue(value) if isinstance(value, Mapping) else None


class CdpAxNode:
    """Read-only attribute view over one ``Accessibility.AXNode``."""

    __slots__ = ("raw",)

    def __init__(self, raw: Mapping[str, Any]) -> None:
        self.raw = raw

    @property
    def node_id(self) -> str:
        return str(self.raw.get("nodeId") or "")

    @property
    def ignored(self) -> bool:
        return bool(self.raw.get("ignored"))

    @property
    def role(self) -> CdpAxValue | None:
        return self._value("role")

    @property
    def name(self) -> CdpAxValue | None:
        return self._value("name")

    @property
    def description(self) -> CdpAxValue | None:
        return self._value("description")

    @property
    def value(self) -> CdpAxValue | None:
        return self._value("value")

    def _value(self, key: str) -> CdpAxValue | None:
        raw = self.raw.get(key)
        return CdpAxValue(raw) if isinstance(raw, Mapping) else None

    @property
    def properties(self) -> list[CdpAxProperty]:
        raw = self.raw.get("properties")
        if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
            return []
        return [CdpAxProperty(item) for item in raw if isinstance(item, Mapping)]

    @property
    def ignored_reasons(self) -> list[CdpAxProperty]:
        raw = self.raw.get("ignoredReasons")
        if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
            return []
        return [CdpAxProperty(item) for item in raw if isinstance(item, Mapping)]

    @property
    def backend_dom_node_id(self) -> int | None:
        value = self.raw.get("backendDOMNodeId")
        return int(value) if isinstance(value, int) else None

    @property
    def parent_id(self) -> str | None:
        value = self.raw.get("parentId")
        return str(value) if value is not None else None

    @property
    def child_ids(self) -> list[str]:
        raw = self.raw.get("childIds")
        if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
            return []
        return [str(item) for item in raw]


def wrap_ax_nodes(payload: Any) -> list[CdpAxNode]:
    """Wraps the ``nodes`` array of an ``Accessibility.get*AXTree`` result."""
    nodes = payload.get("nodes") if isinstance(payload, Mapping) else payload
    if not isinstance(nodes, Sequence) or isinstance(nodes, (str, bytes)):
        return []
    return [CdpAxNode(item) for item in nodes if isinstance(item, Mapping)]


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
    "CdpAxNode",
    "CdpAxProperty",
    "CdpAxValue",
    "CdpNode",
    "CdpSession",
    "CdpTimeoutError",
    "StageBudget",
    "send_bounded",
    "wrap_ax_nodes",
]
