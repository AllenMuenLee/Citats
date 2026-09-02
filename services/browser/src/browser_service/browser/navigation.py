"""Read-only navigation service: NAVIGATE and GET_CONTENT only.

This module deliberately exposes no click/type/submit/script-evaluation
capability anywhere -- that is a hard security boundary for this phase.
:class:`ReadOnlyOperation` enumerates the only two operations that exist.

Redirect safety: every hop of a navigation (the initial URL and every
subsequent redirect target) is revalidated against the same
:class:`~browser_service.browser.policy.UrlPolicy` used for the initial
check, enforced at the network level via Playwright routing -- each redirect
raises its own route for the new target *before* the browser sends that
request -- rather than by inspecting the final URL after the fact. A hop that
fails the policy is aborted, so a disallowed origin is never contacted.

**Why this is Playwright routing and not raw CDP ``Fetch`` interception.**
The previous implementation enabled the ``Fetch`` domain on a single tab
session. A cross-origin document redirect (reproduced with
``www.airbnb.com`` -> ``www.airbnb.ca/v2/domain_switch/handoff``) moves the
tab to a new renderer process, and the ``Fetch`` domain does not carry over:
the paused-request event still arrived, but every disposition for it was
rejected with "Fetch domain is not enabled", and re-enabling the domain
invalidated the interception id rather than recovering it. The document
stayed paused forever, so the renderer never loaded and never answered
another CDP command -- which surfaced to callers as an unexplained
exploration timeout. Playwright's router is driver-managed and follows the
navigation across processes, so the same block-before-issue guarantee now
holds on sites that redirect across origins.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from enum import Enum
from urllib.parse import urljoin

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Page, Route
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from browser_service.browser.policy import PolicyViolation, UrlPolicy

logger = logging.getLogger("browser_service.browser.navigation")

DEFAULT_TOTAL_TIMEOUT_SECONDS = 30.0
DEFAULT_IDLE_TIMEOUT_SECONDS = 10.0
DEFAULT_MAX_REDIRECTS = 10
DEFAULT_MAX_RESPONSE_BYTES = 20_000_000

#: Playwright resource-type names, used for the optional blocklist below.
DOCUMENT_RESOURCE_TYPE = "document"


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


class NavigationInterceptionLostError(NavigationError):
    """A route could not be dispositioned, so the navigation was neither
    policed nor completable.

    Retained from the CDP-interception implementation this module replaced,
    where a cross-process document redirect stranded a paused request
    permanently (see the module docstring). Playwright's router does not have
    that failure mode, but a route can still fail to resolve if the page or
    context is torn down mid-navigation, and the consequences are the same
    both ways: the hop was not policed, and the page must not be reused.
    """

    def __init__(self, url: str, stage: str) -> None:
        super().__init__(f"Lost request interception for {url} at the {stage} stage")
        self.url = url
        self.stage = stage


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
    # Resource types (Playwright ``Request.resource_type`` values, e.g.
    # "media", "image") to refuse outright during navigation. Empty by
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


def _content_length(headers: dict[str, str]) -> int | None:
    raw = headers.get("content-length")
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


async def _watch_idle(get_last_activity: Callable[[], float], idle_timeout_seconds: float) -> None:
    """Resolves once no route activity has been seen for the idle window.

    A navigation can be well inside its total budget and still be dead --
    nothing requested, nothing answered. Racing this against the navigation
    is what turns that into a typed ``idle`` timeout instead of a long wait
    for the total deadline.
    """
    while True:
        remaining = idle_timeout_seconds - (time.monotonic() - get_last_activity())
        if remaining <= 0:
            return
        await asyncio.sleep(min(remaining, 0.05))


class NavigationService:
    """Navigates a page under a URL policy and bounded wall-clock limits."""

    def __init__(self, policy: UrlPolicy, limits: NavigationLimits | None = None) -> None:
        self._policy = policy
        self._limits = limits if limits is not None else NavigationLimits()

    async def navigate(
        self,
        page: Page,
        url: str,
        *,
        cancelled: asyncio.Event | None = None,
        observer: AbstractAsyncContextManager[None] | None = None,
    ) -> NavigationResult:
        """Navigate ``page`` to ``url``.

        Raises :class:`NavigationBlockedError` if the initial URL or any
        redirect hop fails the URL policy, :class:`TooManyRedirectsError` if
        the redirect chain exceeds ``limits.max_redirects``,
        :class:`NavigationTimeoutError` on total/idle timeout, and
        :class:`NavigationCancelledError` if ``cancelled`` is set before
        completion.

        ``observer``, when given, is an already-constructed async context
        manager that this method enters immediately before navigating and
        exits in ``finally`` regardless of outcome. This is a trusted,
        server-only hook for page-observation capture: only this project's
        own server-side code ever constructs one, it is never reachable from
        model- or renderer-supplied input, and no capture/observation setting
        is exposed as a tool argument anywhere. This method never inspects,
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
            hop_count = 0
            blocked_error: PolicyViolation | None = None
            too_many_redirects = False
            response_too_large: tuple[int, int] | None = None
            interception_lost: NavigationInterceptionLostError | None = None
            resolved_url: str | None = None
            last_activity = time.monotonic()

            async def handle(route: Route) -> None:
                nonlocal hop_count, blocked_error, too_many_redirects
                nonlocal response_too_large, interception_lost, resolved_url
                nonlocal last_activity
                last_activity = time.monotonic()
                request = route.request
                try:
                    if request.resource_type in limits.blocked_resource_types:
                        await route.abort("blockedbyclient")
                        return
                    if request.resource_type != DOCUMENT_RESOURCE_TYPE:
                        await route.continue_()
                        return

                    # Playwright fires a route for the *initial* request only:
                    # a server-side 3xx is followed inside the driver, and the
                    # chain is reported afterwards via `redirected_from`. That
                    # is post-hoc, and this service's contract is that a
                    # disallowed hop is never contacted at all. So the chain is
                    # walked here instead, one hop at a time, validating each
                    # `Location` *before* the request for it is issued.
                    current = request.url
                    hops = 0
                    while True:
                        hop_count += 1
                        response = await route.fetch(url=current, max_redirects=0)
                        headers = {
                            name.lower(): value for name, value in response.headers.items()
                        }
                        location = headers.get("location")
                        if not (300 <= response.status < 400) or not location:
                            declared = _content_length(headers)
                            if declared is not None and declared > limits.max_response_bytes:
                                response_too_large = (limits.max_response_bytes, declared)
                                await route.abort("blockedbyresponse")
                                return
                            resolved_url = current
                            await route.fulfill(response=response)
                            return
                        hops += 1
                        if hops > limits.max_redirects:
                            too_many_redirects = True
                            await route.abort("aborted")
                            return
                        target = urljoin(current, location)
                        try:
                            await self._policy.check(target)
                        except PolicyViolation as violation:
                            # Fail closed: the disallowed target is never requested.
                            blocked_error = violation
                            await route.abort("blockedbyclient")
                            return
                        current = target
                except PlaywrightError:
                    # The page or context went away mid-route. Only the
                    # top-level document decides the navigation's fate: an
                    # iframe whose route fails after the main document has
                    # already committed must not retroactively fail a
                    # navigation that succeeded.
                    if interception_lost is not None or request.frame != page.main_frame:
                        return
                    interception_lost = NavigationInterceptionLostError(request.url, "request")
                    logger.warning(
                        "browser_service.browser.interception_lost",
                        extra={"stage": "request", "resource_type": request.resource_type},
                    )

            await page.route("**/*", handle)
            navigation = asyncio.ensure_future(
                page.goto(
                    url,
                    wait_until="domcontentloaded",
                    timeout=limits.total_timeout_seconds * 1000,
                )
            )
            cancel_task = asyncio.ensure_future(cancel_event.wait())
            idle_task = asyncio.ensure_future(
                _watch_idle(lambda: last_activity, limits.idle_timeout_seconds)
            )
            try:
                done, pending = await asyncio.wait(
                    {navigation, cancel_task, idle_task},
                    timeout=limits.total_timeout_seconds,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)

                if navigation not in done:
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await navigation
                    if cancel_task in done:
                        raise NavigationCancelledError(url)
                    if idle_task in done:
                        raise NavigationTimeoutError("idle", limits.idle_timeout_seconds)
                    raise NavigationTimeoutError("total", limits.total_timeout_seconds)

                # Policy outcomes are decided before the transport error a
                # blocked hop necessarily produces: an aborted navigation
                # must report *why* it was aborted, not that it failed.
                if blocked_error is not None:
                    raise NavigationBlockedError(blocked_error)
                if too_many_redirects:
                    raise TooManyRedirectsError(limits.max_redirects)
                if response_too_large is not None:
                    max_bytes, actual_bytes = response_too_large
                    raise ResponseTooLargeError(max_bytes, actual_bytes)
                if interception_lost is not None:
                    raise interception_lost
                try:
                    # Raised for effect: a failed navigation must surface as a
                    # typed error, and the response itself is not needed --
                    # the chain walk above already produced everything this
                    # method reports.
                    navigation.result()
                except PlaywrightTimeoutError as exc:
                    raise NavigationTimeoutError(
                        "total", limits.total_timeout_seconds
                    ) from exc
                except PlaywrightError as exc:
                    raise NavigationError(f"Navigation to {url} failed") from exc

            finally:
                with contextlib.suppress(Exception):
                    await page.unroute("**/*", handle)

            # `page.url` stays on the *requested* URL when a redirect chain was
            # resolved here and fulfilled in place, so the resolved target the
            # walk actually ended on is authoritative. Extraction is handed
            # this value explicitly and resolves relative links against it.
            return NavigationResult(
                operation=ReadOnlyOperation.NAVIGATE,
                requested_url=url,
                final_url=resolved_url or page.url or url,
                redirect_count=max(hop_count - 1, 0),
            )
        finally:
            if observer is not None:
                await observer.__aexit__(None, None, None)

    async def get_content(
        self,
        page: Page,
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

        content_task = asyncio.ensure_future(page.content())
        cancel_task = asyncio.ensure_future(cancel_event.wait())
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
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await content_task
            if cancel_task in done:
                raise NavigationCancelledError(page.url or "")
            raise NavigationTimeoutError("get_content", limits.total_timeout_seconds)

        try:
            content = content_task.result()
        except PlaywrightError as exc:
            raise NavigationError("Page content could not be read") from exc
        size = len(content.encode("utf-8"))
        if size > limits.max_response_bytes:
            raise ResponseTooLargeError(limits.max_response_bytes, size)

        final_url = page.url or ""
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
    "NavigationInterceptionLostError",
    "NavigationLimits",
    "NavigationResult",
    "NavigationService",
    "NavigationTimeoutError",
    "ReadOnlyOperation",
    "ResponseTooLargeError",
    "TooManyRedirectsError",
]
