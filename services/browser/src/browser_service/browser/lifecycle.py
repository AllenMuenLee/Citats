"""Playwright browser lifecycle and per-task isolated contexts.

Owns exactly one controlled Chromium process (started lazily, restarted if it
becomes unhealthy) and allocates an isolated ephemeral
:class:`~playwright.async_api.BrowserContext` per task via
:meth:`BrowserLifecycleManager.isolated_context`, exposed as an async context
manager so contexts/pages are always closed -- even on error or cancellation --
via ``finally``.

Environment knobs (paths/flags only, never credentials):

``BROWSER_SERVICE_CHROME_EXECUTABLE``
    Optional override for the Chromium executable path. Playwright uses its
    own downloaded browser by default (``playwright install chromium``); this
    only exists for hosts that must run a system browser instead.

``BROWSER_SERVICE_HEADED``
    Set to ``1`` to run the browser headed. Headless is the default and is
    what the service runs in normally; a headed run is a diagnostic escape
    hatch for a site that behaves differently without a visible window.

**Why Playwright and not nodriver.** The previous driver policed the
top-level document's redirect chain with a raw CDP ``Fetch`` interception
bound to one tab session. A cross-origin document redirect (reproduced with
``www.airbnb.com`` -> ``www.airbnb.ca/v2/domain_switch/handoff``) moves the
tab to a new renderer process, and the ``Fetch`` domain enabled on the old
session does not carry over: the ``Fetch.requestPaused`` event still arrived,
but every disposition for it was rejected with "Fetch domain is not enabled",
and re-enabling the domain invalidated the interception id rather than
recovering it. The request stayed paused forever, so the renderer never
received a document and never answered another CDP command -- ``DOM``,
``Runtime``, anything -- which surfaced as an unexplained exploration
timeout. Playwright's routing is driver-managed and follows the navigation
across processes, so ``UrlPolicy`` still blocks a disallowed hop *before it
is issued* while the page continues to load normally.

Playwright also removes the "navigate a tab only once" constraint the old
driver had, so a page here is an ordinary reusable page.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from playwright.async_api import (
    Browser,
    BrowserContext,
    CDPSession,
    Page,
    Playwright,
    async_playwright,
)

from browser_service.browser.registry import BrowserResourceRegistry

logger = logging.getLogger("browser_service.browser.lifecycle")

BROWSER_EXECUTABLE_PATH_ENV_VAR = "BROWSER_SERVICE_CHROME_EXECUTABLE"
BROWSER_HEADED_ENV_VAR = "BROWSER_SERVICE_HEADED"
DEFAULT_MAX_CONCURRENT_CONTEXTS = 4
DEFAULT_BROWSER_START_TIMEOUT_SECONDS = 30.0
#: Cleanup must be bounded (P03-R05 step 1). Closing a page over a connection
#: that has already stopped answering is exactly the situation cleanup runs
#: in, so an unbounded `await page.close()` in a `finally` turns one stalled
#: task into a permanently stuck one.
DEFAULT_CLEANUP_TIMEOUT_SECONDS = 5.0
#: Bounded liveness probe used before admitting new work after a task ended
#: badly (P03-R05 steps 3-4). Deliberately a single round trip with a
#: deadline -- never a retry loop.
DEFAULT_HEALTH_PROBE_TIMEOUT_SECONDS = 5.0


async def _bounded_cleanup(awaitable: Any, timeout_seconds: float, operation: str) -> bool:
    """Awaits one cleanup step under a deadline, swallowing every failure.

    Cleanup must never replace the primary typed error a task is already
    reporting (P03-R05 step 1), so this returns success as a boolean and
    logs rather than raising.
    """
    try:
        async with asyncio.timeout(timeout_seconds):
            await awaitable
        return True
    except Exception:  # noqa: BLE001 -- a resource already gone is a fine outcome
        logger.warning("browser_service.browser.cleanup_failed", extra={"operation": operation})
        return False


@dataclass(frozen=True)
class LifecycleConfig:
    """Credential-free lifecycle configuration.

    ``sandbox`` defaults to ``True`` (Chromium's default OS sandbox stays
    enabled) as defense in depth. Only flip it for a concrete, documented
    deployment reason (e.g. a constrained container that cannot support the
    sandbox) -- never default to disabling it, and never wire it to an
    environment variable a production deployment could set implicitly.
    """

    headless: bool = True
    executable_path: str | None = None
    sandbox: bool = True
    max_concurrent_contexts: int = DEFAULT_MAX_CONCURRENT_CONTEXTS
    browser_start_timeout_seconds: float = DEFAULT_BROWSER_START_TIMEOUT_SECONDS
    cleanup_timeout_seconds: float = DEFAULT_CLEANUP_TIMEOUT_SECONDS
    health_probe_timeout_seconds: float = DEFAULT_HEALTH_PROBE_TIMEOUT_SECONDS

    @staticmethod
    def from_env() -> LifecycleConfig:
        executable_path = os.environ.get(BROWSER_EXECUTABLE_PATH_ENV_VAR)
        return LifecycleConfig(
            headless=os.environ.get(BROWSER_HEADED_ENV_VAR, "").strip() != "1",
            executable_path=executable_path if executable_path else None,
        )

    def launch_arguments(self) -> dict[str, Any]:
        """Playwright ``chromium.launch`` keyword arguments for this config."""
        arguments: dict[str, Any] = {"headless": self.headless}
        if self.executable_path:
            arguments["executable_path"] = self.executable_path
        if not self.sandbox:
            arguments["chromium_sandbox"] = False
        return arguments


class IsolatedBrowserContext:
    """One isolated, ephemeral browser context (profile) for a single task.

    Obtain pages via :meth:`open_page`. Every page opened through this handle,
    and the context itself, are closed when the owning
    :meth:`BrowserLifecycleManager.isolated_context` block exits.
    """

    def __init__(
        self,
        context: BrowserContext,
        context_id: str,
        registry: BrowserResourceRegistry,
    ) -> None:
        self._context = context
        self.context_id = context_id
        self._registry = registry
        self._pages: list[Page] = []
        self._cdp_sessions: list[CDPSession] = []
        self._cleanup_timeout_seconds = DEFAULT_CLEANUP_TIMEOUT_SECONDS
        #: Set when a task saw evidence that this context's connection is no
        #: longer trustworthy -- a CDP deadline, a cancellation mid-request.
        #: The manager reads it on exit and probes the shared browser before
        #: admitting new work (P03-R05 step 3).
        self.unhealthy_reason: str | None = None

    @property
    def context(self) -> BrowserContext:
        return self._context

    @property
    def unhealthy(self) -> bool:
        return self.unhealthy_reason is not None

    def mark_unhealthy(self, reason: str) -> None:
        """Records that this context's session may be corrupted.

        Called by task code when a CDP request exceeded its deadline or was
        cancelled mid-flight: the response may still be in flight, so the
        page must be retired rather than reused. The reason is a short
        internal label -- never page content, never an exception message.
        """
        if self.unhealthy_reason is None:
            self.unhealthy_reason = reason[:80]

    async def open_page(self) -> Page:
        """Open and return a brand-new page bound to this isolated context."""
        page = await self._context.new_page()
        self._pages.append(page)
        await self._registry.add_page(self.context_id, str(id(page)))
        return page

    async def open_cdp_session(self, page: Page) -> CDPSession:
        """A raw CDP session for ``page``, for the observation pipeline.

        Page observation needs CDP domains Playwright does not wrap
        (``DOM.getDocument`` with ``pierce``, ``Accessibility.getFullAXTree``,
        ``DOM.getBoxModel``). Sessions opened here are detached alongside the
        pages they belong to, so a task cannot leak one.
        """
        session = await self._context.new_cdp_session(page)
        self._cdp_sessions.append(session)
        return session

    async def close_all_pages(self) -> None:
        """Close every page opened via :meth:`open_page`.

        Called automatically by :meth:`BrowserLifecycleManager.isolated_context`
        on exit; exposed publicly only so that method can call it -- task
        code should not normally need to call this directly.
        """
        for session in self._cdp_sessions:
            await _bounded_cleanup(
                session.detach(), self._cleanup_timeout_seconds, "cdp_session.detach"
            )
        self._cdp_sessions.clear()
        for page in self._pages:
            # Bounded: this runs in a `finally`, often against a connection
            # that has already stopped answering.
            await _bounded_cleanup(page.close(), self._cleanup_timeout_seconds, "page.close")
            with contextlib.suppress(Exception):
                await self._registry.remove_page(self.context_id, str(id(page)))
        self._pages.clear()


class BrowserLifecycleManager:
    """Owns one Chromium process and hands out isolated per-task contexts."""

    def __init__(self, config: LifecycleConfig | None = None) -> None:
        self._config = config if config is not None else LifecycleConfig.from_env()
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._start_lock = asyncio.Lock()
        self._context_semaphore = asyncio.Semaphore(self._config.max_concurrent_contexts)
        self._context_sequence = 0
        self.registry = BrowserResourceRegistry()

    async def is_healthy(self) -> bool:
        return self._browser is not None and self._browser.is_connected()

    async def _ensure_started(self) -> Browser:
        async with self._start_lock:
            if self._browser is None or not self._browser.is_connected():
                if self._browser is not None:
                    logger.warning("browser_service.browser.restart_unhealthy")
                    await self._stop_locked()
                async with asyncio.timeout(self._config.browser_start_timeout_seconds):
                    playwright = await async_playwright().start()
                    try:
                        browser = await playwright.chromium.launch(
                            **self._config.launch_arguments()
                        )
                    except BaseException:
                        with contextlib.suppress(Exception):
                            await playwright.stop()
                        raise
                self._playwright = playwright
                self._browser = browser
            return self._browser

    @asynccontextmanager
    async def isolated_context(self) -> AsyncIterator[IsolatedBrowserContext]:
        """Allocate one ephemeral, isolated browser context for a single task.

        Enforces ``max_concurrent_contexts`` via a semaphore (extra callers
        wait rather than mixing into another task's context). The context
        and every page opened within it are always disposed/closed on exit,
        including on error or cancellation, so no state leaks between
        tasks.
        """
        async with self._context_semaphore:
            browser = await self._ensure_started()
            context = await browser.new_context()
            self._context_sequence += 1
            context_id = f"ctx-{self._context_sequence}"
            await self.registry.register_context(context_id)
            handle = IsolatedBrowserContext(context, context_id, self.registry)
            handle._cleanup_timeout_seconds = self._config.cleanup_timeout_seconds
            try:
                yield handle
            finally:
                # Every step below is bounded and failure-tolerant, and runs
                # regardless of how the task ended -- success, typed error,
                # deadline, or cancellation (P03-R05 steps 1-2).
                await handle.close_all_pages()
                with contextlib.suppress(Exception):
                    await self.registry.unregister_context(context_id)
                await _bounded_cleanup(
                    context.close(), self._config.cleanup_timeout_seconds, "context.close"
                )
                if handle.unhealthy:
                    await self._retire_if_unhealthy(handle.unhealthy_reason or "unknown")

    async def _retire_if_unhealthy(self, reason: str) -> bool:
        """Probes the shared browser once, and replaces it if it fails.

        A task that hit a CDP deadline may have left the connection in a
        state where the next task's first request never answers. One bounded
        round trip decides that -- never a retry loop, which is how a broken
        connection turns into a CPU spin that starves this service's event
        loop (P03-R05 step 4).

        Only this service's own browser process is ever replaced; unrelated
        browsers on the machine are never touched.
        """
        browser = self._browser
        if browser is None:
            return False
        logger.warning("browser_service.browser.unhealthy_context", extra={"reason": reason})
        healthy = browser.is_connected() and await _bounded_cleanup(
            self._probe(browser),
            self._config.health_probe_timeout_seconds,
            "health_probe",
        )
        if healthy:
            return False
        logger.warning("browser_service.browser.retiring_process", extra={"reason": reason})
        await self.restart()
        return True

    @staticmethod
    async def _probe(browser: Browser) -> None:
        """One bounded round trip that proves the browser still answers."""
        context = await browser.new_context()
        await context.close()

    async def reap_abandoned(self, max_age_seconds: float) -> int:
        """Best-effort sweep for contexts older than ``max_age_seconds``.

        Under normal operation ``isolated_context``'s ``finally`` always
        disposes its context, so this only matters as a defensive backstop
        (e.g. a caller that stored the handle outside its ``async with``
        block). Returns the number of stale bookkeeping entries found; it
        does not itself hold browser handles to dispose, so it only reports
        -- callers/integrators should treat a non-zero count as a leak
        signal.
        """
        stale = self.registry.stale_contexts(max_age_seconds)
        if stale:
            logger.warning(
                "browser_service.browser.stale_contexts_detected",
                extra={"count": len(stale)},
            )
        return len(stale)

    async def restart(self) -> None:
        """Force-restart the underlying browser process.

        Kills the OS process, so no existing page/context handle survives --
        a task holding a stale handle fails fast on its next call instead of
        silently continuing against a different task's session. Never leaves
        a partially-torn-down browser referenced.
        """
        await self.shutdown()
        await self._ensure_started()

    async def _stop_locked(self) -> None:
        """Tear down browser and driver. Caller must hold ``_start_lock``."""
        browser, playwright = self._browser, self._playwright
        self._browser = None
        self._playwright = None
        if browser is not None:
            with contextlib.suppress(Exception):
                await browser.close()
        if playwright is not None:
            with contextlib.suppress(Exception):
                await playwright.stop()

    async def shutdown(self) -> None:
        async with self._start_lock:
            await self._stop_locked()


__all__ = [
    "BROWSER_EXECUTABLE_PATH_ENV_VAR",
    "BROWSER_HEADED_ENV_VAR",
    "BrowserLifecycleManager",
    "IsolatedBrowserContext",
    "LifecycleConfig",
]
