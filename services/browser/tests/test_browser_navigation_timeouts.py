"""Timeout/cancellation control-flow tests for NavigationService.

These exercise ``NavigationService.navigate``'s own timeout/cancellation
detection and typed-error mapping -- not the driver's real network
behaviour -- so they use a minimal fake page double instead of a real
browser.

What these scenarios need to prove is that ``navigate`` correctly (a) races
the navigation against an idle watchdog, a total deadline, and an external
cancellation event, (b) stops waiting and raises the right typed error for
whichever fired, and (c) never resolves successfully once one of those
fired. None of that depends on real browser behaviour, so a fake page that
simply sleeps past the configured limits exercises the same code path
deterministically and in a fraction of the time. Real-browser behaviour
(successful navigation, URL-policy enforcement, redirect handling,
response-size caps) is covered by ``test_browser_navigation.py``.
"""

from __future__ import annotations

import asyncio
from typing import Any, cast

import pytest
from playwright.async_api import Page

from browser_service.browser.navigation import (
    NavigationCancelledError,
    NavigationLimits,
    NavigationService,
    NavigationTimeoutError,
)
from browser_service.browser.policy import UrlPolicy


class _FakeSlowPage:
    """Minimal stand-in for the subset of Playwright's ``Page`` that
    ``NavigationService.navigate`` touches: it never talks to a browser, it
    just sleeps past whatever timeout/cancellation the test configures.

    ``goto`` never triggers the registered route handler, which is exactly
    the "nothing is happening" condition the idle watchdog exists to catch.
    """

    def __init__(self, delay_seconds: float, url: str = "about:blank") -> None:
        self.url = url
        self._delay_seconds = delay_seconds
        self._routes: list[Any] = []

    async def route(self, pattern: str, handler: Any) -> None:
        self._routes.append((pattern, handler))

    async def unroute(self, pattern: str, handler: Any = None) -> None:
        self._routes = [entry for entry in self._routes if entry[0] != pattern]

    async def goto(self, url: str, **_kwargs: Any) -> None:
        await asyncio.sleep(self._delay_seconds)
        self.url = url
        return None


def make_service(limits: NavigationLimits) -> NavigationService:
    # No real navigation ever reaches the network, so no host needs to be
    # allowlisted -- the fake page's .get() never calls out to a real URL.
    return NavigationService(UrlPolicy(test_only_allowed_hosts=frozenset({"example.test"})), limits)


def test_idle_timeout_fires_when_the_page_never_responds() -> None:
    limits = NavigationLimits(idle_timeout_seconds=0.2, total_timeout_seconds=10.0)
    service = make_service(limits)
    page = cast(Page, _FakeSlowPage(delay_seconds=5.0))

    async def run() -> None:
        with pytest.raises(NavigationTimeoutError) as excinfo:
            await service.navigate(page, "http://example.test/slow")
        assert excinfo.value.phase == "idle"

    asyncio.run(run())


def test_total_timeout_fires_even_though_nothing_is_technically_idle() -> None:
    limits = NavigationLimits(idle_timeout_seconds=10.0, total_timeout_seconds=0.2)
    service = make_service(limits)
    page = cast(Page, _FakeSlowPage(delay_seconds=5.0))

    async def run() -> None:
        with pytest.raises(NavigationTimeoutError) as excinfo:
            await service.navigate(page, "http://example.test/slow")
        assert excinfo.value.phase == "total"

    asyncio.run(run())


def test_explicit_cancellation_stops_an_in_flight_navigation() -> None:
    limits = NavigationLimits(idle_timeout_seconds=10.0, total_timeout_seconds=10.0)
    service = make_service(limits)
    page = cast(Page, _FakeSlowPage(delay_seconds=5.0))

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
    page = cast(Page, _FakeSlowPage(delay_seconds=5.0))

    async def run() -> None:
        try:
            result = await service.navigate(page, "http://example.test/slow")
        except NavigationTimeoutError:
            return
        pytest.fail(f"expected NavigationTimeoutError, got a result: {result!r}")

    asyncio.run(run())
