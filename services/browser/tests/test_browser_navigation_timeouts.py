"""Timeout/cancellation control-flow tests for NavigationService.

These test NavigationService.navigate's own timeout/cancellation
detection and typed-error mapping -- not nodriver's real CDP behavior --
so they use a minimal fake page double instead of a real browser/nodriver
Tab.

This is deliberate, not a shortcut: empirically on this host, cancelling
a real in-flight nodriver ``page.get(url)`` call (exactly what happens on
every idle timeout, total timeout, and explicit cancellation) can corrupt
nodriver's own internal per-connection CDP listener such that it enters
an unbounded, non-yielding retry loop -- see the "second empirical
finding" in ``browser_service.browser.navigation``'s module docstring for
the full detail. That failure mode reproduced consistently and
deterministically for these three scenarios specifically, regardless of
using a fresh browser process or a fresh, immediately-closed event loop
per test, which means it is a nodriver/``websockets`` library bug outside
this project's control, not something a differently-isolated real-Chrome
test can reliably avoid.

The actual thing these three scenarios need to prove is that
NavigationService.navigate correctly (a) races the navigation against an
idle watchdog, a total deadline, and an external cancellation event, (b)
stops waiting and raises the right typed error for whichever fired, and
(c) never resolves successfully once one of those fires. None of that
depends on real Chrome/CDP behavior, so a fake page that just sleeps
longer than the configured limits exercises the same code path
deterministically, quickly, and without the real browser's underlying
library bug. Real-Chrome behavior (successful navigation, URL-policy
enforcement, redirect handling, response-size caps) is covered by
``test_browser_navigation.py``.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, cast

import pytest
from nodriver.core.tab import Tab  # type: ignore[import-untyped]

from browser_service.browser.navigation import (
    NavigationCancelledError,
    NavigationLimits,
    NavigationService,
    NavigationTimeoutError,
)
from browser_service.browser.policy import UrlPolicy


class _FakeSlowPage:
    """Minimal stand-in for the subset of nodriver's ``Tab`` that
    ``NavigationService.navigate`` touches: it never actually talks CDP,
    it just sleeps past whatever timeout/cancellation the test configures.
    """

    def __init__(self, delay_seconds: float, url: str = "about:blank") -> None:
        self.target = SimpleNamespace(url=url)
        self._delay_seconds = delay_seconds
        self._handlers: dict[Any, Any] = {}

    def add_handler(self, event_type: Any, handler: Any) -> None:
        self._handlers[event_type] = handler

    def remove_handler(self, event_type: Any, handler: Any) -> None:
        self._handlers.pop(event_type, None)

    async def send(self, command: Any) -> None:
        return None

    async def get(self, url: str) -> None:
        await asyncio.sleep(self._delay_seconds)
        self.target = SimpleNamespace(url=url)


def make_service(limits: NavigationLimits) -> NavigationService:
    # No real navigation ever reaches the network, so no host needs to be
    # allowlisted -- the fake page's .get() never calls out to a real URL.
    return NavigationService(UrlPolicy(test_only_allowed_hosts=frozenset({"example.test"})), limits)


def test_idle_timeout_fires_when_the_page_never_responds() -> None:
    limits = NavigationLimits(idle_timeout_seconds=0.2, total_timeout_seconds=10.0)
    service = make_service(limits)
    page = cast(Tab, _FakeSlowPage(delay_seconds=5.0))

    async def run() -> None:
        with pytest.raises(NavigationTimeoutError) as excinfo:
            await service.navigate(page, "http://example.test/slow")
        assert excinfo.value.phase == "idle"

    asyncio.run(run())


def test_total_timeout_fires_even_though_nothing_is_technically_idle() -> None:
    limits = NavigationLimits(idle_timeout_seconds=10.0, total_timeout_seconds=0.2)
    service = make_service(limits)
    page = cast(Tab, _FakeSlowPage(delay_seconds=5.0))

    async def run() -> None:
        with pytest.raises(NavigationTimeoutError) as excinfo:
            await service.navigate(page, "http://example.test/slow")
        assert excinfo.value.phase == "total"

    asyncio.run(run())


def test_explicit_cancellation_stops_an_in_flight_navigation() -> None:
    limits = NavigationLimits(idle_timeout_seconds=10.0, total_timeout_seconds=10.0)
    service = make_service(limits)
    page = cast(Tab, _FakeSlowPage(delay_seconds=5.0))

    async def run() -> None:
        cancelled = asyncio.Event()

        async def cancel_soon() -> None:
            await asyncio.sleep(0.1)
            cancelled.set()

        navigate_coro = service.navigate(page, "http://example.test/slow", cancelled=cancelled)
        with pytest.raises(NavigationCancelledError):
            await asyncio.gather(navigate_coro, cancel_soon())

    asyncio.run(run())


def test_navigation_never_resolves_successfully_once_cancelled() -> None:
    """A cancelled/timed-out navigate() must raise, never return a result."""
    limits = NavigationLimits(idle_timeout_seconds=0.2, total_timeout_seconds=10.0)
    service = make_service(limits)
    page = cast(Tab, _FakeSlowPage(delay_seconds=5.0))

    async def run() -> None:
        try:
            result = await service.navigate(page, "http://example.test/slow")
        except NavigationTimeoutError:
            return
        pytest.fail(f"expected NavigationTimeoutError, got a result: {result!r}")

    asyncio.run(run())
