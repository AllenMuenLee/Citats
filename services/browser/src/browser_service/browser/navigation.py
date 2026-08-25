"""Read-only navigation service: NAVIGATE and GET_CONTENT only.

This module deliberately exposes no click/type/submit/script-evaluation
capability anywhere -- that is a hard security boundary for this phase.
``ReadOnlyOperation`` enumerates the only two operations that exist.

Redirect safety: every hop of a navigation (the initial URL and every
subsequent redirect target) is revalidated against the same
:class:`~browser_service.browser.policy.UrlPolicy` used for the initial
check, enforced at the network level via the CDP Fetch domain (each
redirect generates its own ``Fetch.requestPaused`` event for the new
target *before* Chrome ever sends that request) rather than by inspecting
the final URL after the fact.

Operational constraint learned from empirical testing against real Chrome
on this host (see ``lifecycle.py`` module docstring for detail): call
:meth:`NavigationService.navigate` **at most once** per page/tab. Obtain a
fresh page from :class:`~browser_service.browser.lifecycle.IsolatedBrowserContext.open_page`
for every navigation. :meth:`NavigationService.get_content` may safely be
called any number of times against a page that has already been
successfully navigated.

Second empirical finding: cancelling an in-flight ``page.get(url)`` call
(the ``nav_task.cancel()`` path below, taken on idle timeout, total
timeout, and explicit cancellation alike) can leave an orphaned nodriver
background task behind -- its per-connection ``_listener``, which reads
every CDP message for that browser over one shared websocket -- that
``Browser.stop()`` does not actually cancel. That orphaned task keeps
running on whatever asyncio event loop it was created on; once its
websocket is gone, every retry inside it immediately raises
``AssertionError: cannot call get() concurrently`` deep inside the
``websockets`` library, and nodriver's own retry loop has no backoff, so
it spins as fast as possible forever, pinning a CPU core and starving
every *other* coroutine scheduled on that same event loop (including
completely unrelated later tasks) of CPU time. This is a nodriver/
``websockets`` concurrency bug, not a defect in this method's
cancellation handling, which correctly stops waiting and never reuses the
cancelled page. Starting a fresh browser process for the next task is
*not* sufficient to recover from this if that fresh browser's work is
scheduled on the same event loop the orphaned task is still running on,
and empirically it can still reproduce even with a fresh, immediately-
closed ``asyncio.run()`` per attempt -- see
``test_browser_navigation_timeouts.py``'s module docstring, which is why
this project's own timeout/cancellation tests exercise this method's
control flow against a fake page rather than a real one. A long-lived
production event loop cannot sidestep this the way a test can, so treat
any
:class:`NavigationTimeoutError`/:class:`NavigationCancelledError` as a
signal to route subsequent work carefully and watch for rising baseline
CPU usage as a symptom of this until it is fixed upstream.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from nodriver.cdp import fetch as cdp_fetch
from nodriver.cdp import network as cdp_network
from nodriver.core.tab import Tab  # type: ignore[import-untyped]

from browser_service.browser.policy import PolicyViolation, UrlPolicy

logger = logging.getLogger("browser_service.browser.navigation")

DEFAULT_TOTAL_TIMEOUT_SECONDS = 30.0
DEFAULT_IDLE_TIMEOUT_SECONDS = 10.0
DEFAULT_MAX_REDIRECTS = 10
DEFAULT_MAX_RESPONSE_BYTES = 20_000_000


class ReadOnlyOperation(Enum):
    """The only two operations this module performs. Nothing else exists."""

    NAVIGATE = "navigate"
    GET_CONTENT = "get_content"


class NavigationError(Exception):
    """Base class for all navigation-service failures."""


class NavigationTimeoutError(NavigationError):
    def __init__(self, phase: str, timeout_seconds: float) -> None:
        super().__init__(f"Navigation {phase} timed out after {timeout_seconds}s")
        self.phase = phase
        self.timeout_seconds = timeout_seconds


class NavigationCancelledError(NavigationError):
    def __init__(self, url: str) -> None:
        super().__init__(f"Navigation to {url} was cancelled")
        self.url = url


class TooManyRedirectsError(NavigationError):
    def __init__(self, max_redirects: int) -> None:
        super().__init__(f"Exceeded maximum of {max_redirects} redirects")
        self.max_redirects = max_redirects


class ResponseTooLargeError(NavigationError):
    def __init__(self, max_bytes: int, actual_bytes: int) -> None:
        super().__init__(f"Response size {actual_bytes} exceeds cap of {max_bytes} bytes")
        self.max_bytes = max_bytes
        self.actual_bytes = actual_bytes


class NavigationBlockedError(NavigationError):
    """A navigation or redirect target was rejected by the URL policy."""

    def __init__(self, violation: PolicyViolation) -> None:
        super().__init__(str(violation))
        self.url = violation.url
        self.reason = violation.reason


@dataclass(frozen=True)
class NavigationLimits:
    """Bounds enforced by :class:`NavigationService`."""

    total_timeout_seconds: float = DEFAULT_TOTAL_TIMEOUT_SECONDS
    idle_timeout_seconds: float = DEFAULT_IDLE_TIMEOUT_SECONDS
    max_redirects: int = DEFAULT_MAX_REDIRECTS
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES
    # Resource types (CDP ``network.ResourceType`` string values, e.g.
    # "Media", "Image") to refuse outright during navigation. Empty by
    # default -- only the top-level Document request/redirect chain is
    # policed unless an integrator opts into blocking additional types.
    blocked_resource_types: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class NavigationResult:
    operation: ReadOnlyOperation
    requested_url: str
    final_url: str
    redirect_count: int
    content: str | None = None


async def _safe_send(command: Awaitable[object]) -> None:
    """Best-effort CDP send for Fetch dispositions.

    Late events can race a navigation's own completion/cleanup (e.g. a
    disposition for a request that the browser has already abandoned);
    failures here must never crash the event-dispatch task or surface as
    "Task exception was never retrieved" noise.
    """
    try:
        await command
    except Exception:  # noqa: BLE001 -- best-effort disposition, never fatal
        logger.debug("browser_service.browser.fetch_disposition_failed", exc_info=True)


def _extract_content_length(headers: list[cdp_fetch.HeaderEntry] | None) -> int | None:
    if not headers:
        return None
    for header in headers:
        if header.name.lower() == "content-length":
            try:
                return int(header.value)
            except ValueError:
                return None
    return None


async def _watch_idle(get_last_activity: Callable[[], float], idle_timeout_seconds: float) -> None:
    while True:
        remaining = idle_timeout_seconds - (time.monotonic() - get_last_activity())
        if remaining <= 0:
            return
        await asyncio.sleep(min(remaining, 0.2))


class NavigationService:
    """Performs bounded, read-only NAVIGATE and GET_CONTENT operations."""

    def __init__(self, policy: UrlPolicy, limits: NavigationLimits | None = None) -> None:
        self._policy = policy
        self._limits = limits if limits is not None else NavigationLimits()

    async def navigate(
        self,
        page: Tab,
        url: str,
        *,
        cancelled: asyncio.Event | None = None,
        observer: AbstractAsyncContextManager[None] | None = None,
    ) -> NavigationResult:
        """Navigate ``page`` (a freshly-opened tab) to ``url``.

        Raises :class:`NavigationBlockedError` if the initial URL or any
        redirect hop fails the URL policy, :class:`TooManyRedirectsError` if
        the redirect chain exceeds ``limits.max_redirects``,
        :class:`NavigationTimeoutError` on total/idle timeout, and
        :class:`NavigationCancelledError` if ``cancelled`` is set before
        completion.

        ``observer``, when given, is an already-constructed async context
        manager -- e.g. ``browser_service.network.capture.capture_network(page, ...)``
        -- that this method enters immediately before navigating and exits
        in ``finally`` regardless of outcome. This is a trusted, server-only
        hook for later phases (network-traffic capture for API discovery)
        to observe a navigation: only this project's own server-side code
        ever constructs one, it is never reachable from model- or
        renderer-supplied input, and no capture/observation setting is
        exposed as a tool argument anywhere. This method never inspects,
        alters, or exposes whatever the observer itself collects, and an
        observer can only watch -- it has no way to click, fill, submit, or
        otherwise mutate the page.
        """
        cancel_event = cancelled if cancelled is not None else asyncio.Event()
        try:
            await self._policy.check(url)
        except PolicyViolation as exc:
            raise NavigationBlockedError(exc) from exc

        if observer is not None:
            await observer.__aenter__()
        try:
            limits = self._limits
            blocked_resource_types = {
                cdp_network.ResourceType(name) for name in limits.blocked_resource_types
            }
            hop_count = 0
            blocked_error: PolicyViolation | None = None
            too_many_redirects = False
            response_too_large: tuple[int, int] | None = None
            last_activity = time.monotonic()

            async def on_paused(event: cdp_fetch.RequestPaused, tab: Tab) -> None:
                nonlocal hop_count, blocked_error, too_many_redirects
                nonlocal last_activity, response_too_large
                last_activity = time.monotonic()

                if event.resource_type in blocked_resource_types:
                    await _safe_send(
                        tab.send(
                            cdp_fetch.fail_request(
                                event.request_id, cdp_network.ErrorReason.BLOCKED_BY_CLIENT
                            )
                        )
                    )
                    return

                if event.resource_type != cdp_network.ResourceType.DOCUMENT:
                    await _safe_send(
                        tab.send(cdp_fetch.continue_request(request_id=event.request_id))
                    )
                    return

                if event.response_headers is not None:
                    content_length = _extract_content_length(event.response_headers)
                    if content_length is not None and content_length > limits.max_response_bytes:
                        response_too_large = (limits.max_response_bytes, content_length)
                        await _safe_send(
                            tab.send(
                                cdp_fetch.fail_request(
                                    event.request_id, cdp_network.ErrorReason.BLOCKED_BY_RESPONSE
                                )
                            )
                        )
                        return
                    await _safe_send(
                        tab.send(cdp_fetch.continue_response(request_id=event.request_id))
                    )
                    return

                hop_count += 1
                if hop_count > limits.max_redirects + 1:
                    too_many_redirects = True
                    await _safe_send(
                        tab.send(
                            cdp_fetch.fail_request(
                                event.request_id, cdp_network.ErrorReason.ABORTED
                            )
                        )
                    )
                    return

                try:
                    await self._policy.check(event.request.url)
                except PolicyViolation as exc:
                    blocked_error = exc
                    await _safe_send(
                        tab.send(
                            cdp_fetch.fail_request(
                                event.request_id, cdp_network.ErrorReason.BLOCKED_BY_CLIENT
                            )
                        )
                    )
                    return

                await _safe_send(tab.send(cdp_fetch.continue_request(request_id=event.request_id)))

            patterns = [
                cdp_fetch.RequestPattern(
                    resource_type=cdp_network.ResourceType.DOCUMENT,
                    request_stage=cdp_fetch.RequestStage.REQUEST,
                ),
                cdp_fetch.RequestPattern(
                    resource_type=cdp_network.ResourceType.DOCUMENT,
                    request_stage=cdp_fetch.RequestStage.RESPONSE,
                ),
            ]
            for resource_type in blocked_resource_types:
                patterns.append(
                    cdp_fetch.RequestPattern(
                        resource_type=resource_type,
                        request_stage=cdp_fetch.RequestStage.REQUEST,
                    )
                )

            page.add_handler(cdp_fetch.RequestPaused, on_paused)
            try:
                await page.send(cdp_fetch.enable(patterns=patterns))

                nav_task: asyncio.Future[Any] = asyncio.ensure_future(page.get(url))
                cancel_task: asyncio.Future[Any] = asyncio.ensure_future(cancel_event.wait())
                idle_task: asyncio.Future[Any] = asyncio.ensure_future(
                    _watch_idle(lambda: last_activity, limits.idle_timeout_seconds)
                )
                done, pending = await asyncio.wait(
                    {nav_task, cancel_task, idle_task},
                    timeout=limits.total_timeout_seconds,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)

                if nav_task not in done:
                    nav_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await nav_task
                    if cancel_task in done:
                        raise NavigationCancelledError(url)
                    if idle_task in done:
                        raise NavigationTimeoutError("idle", limits.idle_timeout_seconds)
                    raise NavigationTimeoutError("total", limits.total_timeout_seconds)

                nav_task.result()
            finally:
                page.remove_handler(cdp_fetch.RequestPaused, on_paused)
                with contextlib.suppress(Exception):
                    await page.send(cdp_fetch.disable())

            if blocked_error is not None:
                raise NavigationBlockedError(blocked_error)
            if too_many_redirects:
                raise TooManyRedirectsError(limits.max_redirects)
            if response_too_large is not None:
                max_bytes, actual_bytes = response_too_large
                raise ResponseTooLargeError(max_bytes, actual_bytes)

            final_url = page.target.url if page.target is not None and page.target.url else url
            return NavigationResult(
                operation=ReadOnlyOperation.NAVIGATE,
                requested_url=url,
                final_url=final_url,
                redirect_count=max(hop_count - 1, 0),
            )
        finally:
            if observer is not None:
                await observer.__aexit__(None, None, None)

    async def get_content(
        self,
        page: Tab,
        *,
        cancelled: asyncio.Event | None = None,
    ) -> NavigationResult:
        """Return the serialized post-render DOM of an already-navigated ``page``.

        Raises :class:`ResponseTooLargeError` if the content exceeds
        ``limits.max_response_bytes``, :class:`NavigationTimeoutError` on
        timeout, and :class:`NavigationCancelledError` if cancelled first.
        """
        cancel_event = cancelled if cancelled is not None else asyncio.Event()
        limits = self._limits

        content_task: asyncio.Future[Any] = asyncio.ensure_future(page.get_content())
        cancel_task: asyncio.Future[Any] = asyncio.ensure_future(cancel_event.wait())
        done, pending = await asyncio.wait(
            {content_task, cancel_task},
            timeout=limits.total_timeout_seconds,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

        if content_task not in done:
            content_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await content_task
            if cancel_task in done:
                raise NavigationCancelledError(page.target.url if page.target else "")
            raise NavigationTimeoutError("get_content", limits.total_timeout_seconds)

        content = content_task.result()
        size = len(content.encode("utf-8"))
        if size > limits.max_response_bytes:
            raise ResponseTooLargeError(limits.max_response_bytes, size)

        final_url = page.target.url if page.target is not None and page.target.url else ""
        return NavigationResult(
            operation=ReadOnlyOperation.GET_CONTENT,
            requested_url=final_url,
            final_url=final_url,
            redirect_count=0,
            content=content,
        )


__all__ = [
    "NavigationBlockedError",
    "NavigationCancelledError",
    "NavigationError",
    "NavigationLimits",
    "NavigationResult",
    "NavigationService",
    "NavigationTimeoutError",
    "ReadOnlyOperation",
    "ResponseTooLargeError",
    "TooManyRedirectsError",
]
