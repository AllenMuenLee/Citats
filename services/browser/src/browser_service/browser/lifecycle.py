"""Nodriver browser process lifecycle and per-task isolated contexts.

Owns exactly one controlled Chrome process (started lazily, restarted if it
becomes unhealthy) and allocates an isolated ephemeral browser context
(profile) per task via :meth:`BrowserLifecycleManager.isolated_context`,
exposed as an async context manager so contexts/pages are always closed --
even on error or cancellation -- via ``finally``.

Environment knobs (paths/flags only, never credentials):

``BROWSER_SERVICE_CHROME_EXECUTABLE``
    Optional override for the Chrome executable path. nodriver
    auto-detects the installed Chrome binary by default; this only exists
    for portability to hosts where auto-detection fails.

Known environment quirk (Windows + nodriver + asyncio ProactorEventLoop):
after ``Browser.stop()`` kills the Chrome subprocess, harmless
``ResourceWarning``/``ValueError: I/O operation on closed pipe`` noise can
appear during interpreter/process teardown. This is a benign nodriver/
asyncio/Windows interaction, not a bug in this module.

A hard-won operational note from empirical testing against real Chrome on
this host: a single ``nodriver`` ``Tab`` must only ever be navigated once
via ``Page.navigate`` (i.e. ``Tab.get()``/``NavigationService.navigate``).
Re-navigating the same ``Tab`` a second time -- even long after the first
navigation finished cleanly -- reliably wedges that tab's CDP session such
that the second ``Page.navigate`` command never receives a response. This
reproduces with or without Fetch-domain interception involved, so it is a
nodriver/CDP session-reattachment quirk, not a bug in the navigation
service's redirect handling. The safe pattern (used throughout this
module) is: obtain a *new* page from :meth:`IsolatedBrowserContext.open_page`
for every navigation; only call ``get_content`` repeatedly against a page
that has already been successfully navigated once.
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

import nodriver
from nodriver.cdp import target as cdp_target
from nodriver.cdp.browser import BrowserContextID
from nodriver.core.browser import Browser  # type: ignore[import-untyped]
from nodriver.core.tab import Tab  # type: ignore[import-untyped]

from browser_service.browser.registry import BrowserResourceRegistry

logger = logging.getLogger("browser_service.browser.lifecycle")

BROWSER_EXECUTABLE_PATH_ENV_VAR = "BROWSER_SERVICE_CHROME_EXECUTABLE"
DEFAULT_MAX_CONCURRENT_CONTEXTS = 4
DEFAULT_BROWSER_START_TIMEOUT_SECONDS = 30.0
#: Cleanup must be bounded (P03-R05 step 1). Closing a page over a websocket
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
    except (TimeoutError, asyncio.CancelledError):
        logger.warning("browser_service.browser.cleanup_timeout", extra={"operation": operation})
        return False
    except Exception:  # noqa: BLE001 -- a resource already gone is a fine outcome
        logger.warning("browser_service.browser.cleanup_failed", extra={"operation": operation})
        return False


@dataclass(frozen=True)
class LifecycleConfig:
    """Credential-free lifecycle configuration.

    ``sandbox`` defaults to ``True`` (Chrome's default OS sandbox stays
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
            executable_path=executable_path if executable_path else None,
        )


class IsolatedBrowserContext:
    """One isolated, ephemeral browser context (profile) for a single task.

    Obtain fresh pages via :meth:`open_page` -- one per navigation (see the
    module docstring for why a page must not be re-navigated). All pages
    opened through this handle are closed when the owning
    :meth:`BrowserLifecycleManager.isolated_context` block exits.
    """

    def __init__(
        self,
        browser: Browser,
        context_id: BrowserContextID,
        registry: BrowserResourceRegistry,
        anchor_page: Tab,
    ) -> None:
        self._browser = browser
        self.context_id = context_id
        self._registry = registry
        self._pages: list[Tab] = []
        self._cleanup_timeout_seconds = DEFAULT_CLEANUP_TIMEOUT_SECONDS
        #: Set when a task saw evidence that this context's connection is no
        #: longer trustworthy -- a CDP deadline, a cancellation mid-request.
        #: The manager reads it on exit and probes the shared browser before
        #: admitting new work (P03-R05 step 3).
        self.unhealthy_reason: str | None = None
        # Chrome requires at least one open window/tab per browser context
        # to be able to attach further tabs to it (empirically confirmed:
        # closing this page before calling open_page() makes every
        # subsequent create_target() fail with "no browser is open"). This
        # anchor is never returned to callers and never navigated -- it
        # only keeps the context's window alive -- and is closed last, when
        # the whole isolated context tears down.
        self._anchor_page = anchor_page

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

    async def open_page(self) -> Tab:
        """Open and return a brand-new page/tab bound to this isolated context."""
        target_id = await self._browser.send(
            cdp_target.create_target(
                url="about:blank",
                browser_context_id=self.context_id,
                new_window=False,
            )
        )
        await self._browser.sleep(0.25)
        page = next(
            connection
            for connection in self._browser.targets
            if connection.target is not None
            and connection.target.type_ == "page"
            and connection.target.target_id == target_id
        )
        self._pages.append(page)
        await self._registry.add_page(str(self.context_id), str(target_id))
        return page

    async def close_all_pages(self) -> None:
        """Close every page opened via :meth:`open_page`.

        Called automatically by :meth:`BrowserLifecycleManager.isolated_context`
        on exit; exposed publicly only so that method can call it -- task
        code should not normally need to call this directly.
        """
        for page in self._pages:
            target_id = page.target.target_id if page.target is not None else None
            # Bounded: this runs in a `finally`, often against a websocket
            # that has already stopped answering.
            await _bounded_cleanup(page.close(), self._cleanup_timeout_seconds, "page.close")
            if target_id is not None:
                with contextlib.suppress(Exception):
                    await self._registry.remove_page(str(self.context_id), str(target_id))
        self._pages.clear()
        await _bounded_cleanup(
            self._anchor_page.close(), self._cleanup_timeout_seconds, "anchor_page.close"
        )


class BrowserLifecycleManager:
    """Owns one Chrome process and hands out isolated per-task contexts."""

    def __init__(self, config: LifecycleConfig | None = None) -> None:
        self._config = config if config is not None else LifecycleConfig.from_env()
        self._browser: Browser | None = None
        self._start_lock = asyncio.Lock()
        self._context_semaphore = asyncio.Semaphore(self._config.max_concurrent_contexts)
        self.registry = BrowserResourceRegistry()

    async def is_healthy(self) -> bool:
        return self._browser is not None and not self._browser.stopped

    async def _ensure_started(self) -> Browser:
        async with self._start_lock:
            if self._browser is None or self._browser.stopped:
                if self._browser is not None:
                    logger.warning("browser_service.browser.restart_unhealthy")
                self._browser = await asyncio.wait_for(
                    nodriver.start(  # type: ignore[attr-defined]
                        headless=self._config.headless,
                        browser_executable_path=self._config.executable_path,
                        sandbox=self._config.sandbox,
                    ),
                    timeout=self._config.browser_start_timeout_seconds,
                )
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
            seed_page = await browser.create_context(url="about:blank")
            context_id = seed_page.target.browser_context_id if seed_page.target else None
            if context_id is None:
                with contextlib.suppress(Exception):
                    await seed_page.close()
                raise RuntimeError("nodriver did not return a browser context id")

            await self.registry.register_context(str(context_id))
            # The seed page/tab created implicitly by create_context() is
            # never itself navigated or returned to callers -- fresh pages
            # are handed out via open_page() for every actual navigation --
            # but it must stay open for the lifetime of the context (see
            # IsolatedBrowserContext's anchor_page docstring).
            handle = IsolatedBrowserContext(browser, context_id, self.registry, seed_page)
            handle._cleanup_timeout_seconds = self._config.cleanup_timeout_seconds
            try:
                yield handle
            finally:
                # Every step below is bounded and failure-tolerant, and runs
                # regardless of how the task ended -- success, typed error,
                # deadline, or cancellation (P03-R05 steps 1-2).
                await handle.close_all_pages()
                with contextlib.suppress(Exception):
                    await self.registry.unregister_context(str(context_id))
                await _bounded_cleanup(
                    browser.send(cdp_target.dispose_browser_context(context_id)),
                    self._config.cleanup_timeout_seconds,
                    "dispose_browser_context",
                )
                if handle.unhealthy:
                    await self._retire_if_unhealthy(handle.unhealthy_reason or "unknown")

    async def _retire_if_unhealthy(self, reason: str) -> bool:
        """Probes the shared browser once, and replaces it if it fails.

        A task that hit a CDP deadline may have left the connection in a
        state where the next task's first request never answers. One bounded
        round trip decides that -- never a retry loop, which is how a broken
        websocket listener turns into a CPU spin that starves this service's
        event loop (P03-R05 step 4).

        Only this service's own browser process is ever replaced; unrelated
        Chrome processes on the machine are never touched.
        """
        browser = self._browser
        if browser is None:
            return False
        logger.warning("browser_service.browser.unhealthy_context", extra={"reason": reason})
        healthy = await _bounded_cleanup(
            browser.send(cdp_target.get_targets()),
            self._config.health_probe_timeout_seconds,
            "health_probe",
        )
        if healthy and not browser.stopped:
            return False
        logger.warning("browser_service.browser.retiring_process", extra={"reason": reason})
        await self.restart()
        return True

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

        Kills the OS process, so no existing ``Tab``/context handle
        survives -- a task holding a stale handle fails fast on its next
        CDP call instead of silently continuing against a different task's
        session. Never leaves a partially-torn-down browser referenced.
        """
        await self.shutdown()
        await self._ensure_started()

    async def shutdown(self) -> None:
        async with self._start_lock:
            browser = self._browser
            self._browser = None
        if browser is not None:
            with contextlib.suppress(Exception):
                browser.stop()  # synchronous -- must NOT be awaited


__all__ = [
    "BROWSER_EXECUTABLE_PATH_ENV_VAR",
    "BrowserLifecycleManager",
    "IsolatedBrowserContext",
    "LifecycleConfig",
]
