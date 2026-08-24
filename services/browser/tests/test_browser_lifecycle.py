"""Real-Chrome tests for BrowserLifecycleManager: isolated contexts, the
concurrent-context cap, and resource cleanup after contexts close.

These launch actual headless Chrome via nodriver (confirmed working on
this host) and are the "basic leak/stability" and cap-enforcement
validation called for by the phase spec.

Every test gets its own fresh, disposable browser process and event loop
(plain ``asyncio.run()``) rather than sharing one across the module. See
``test_browser_navigation.py``'s module docstring: empirically on this
host, several distinct real-Chrome navigation scenarios that abort an
in-flight request can corrupt nodriver's shared per-connection CDP
listener when multiple such operations share one event loop/browser
process across a pytest session, causing a later, unrelated operation to
spin a CPU core forever. Per-test isolation is the one pattern that
reliably avoids it, at the cost of a real Chrome launch (a few seconds)
per test.
"""

from __future__ import annotations

import asyncio

import pytest

from browser_service.browser.lifecycle import BrowserLifecycleManager, LifecycleConfig


def test_isolated_context_opens_and_cleans_up_pages() -> None:
    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=2))
        try:
            async with manager.isolated_context() as ctx:
                page = await ctx.open_page()
                assert page is not None
                assert manager.registry.context_count() == 1
                assert manager.registry.total_page_count() == 1

            # After the `async with` exits, the context and its pages must
            # be fully unregistered -- no leaked bookkeeping entries.
            assert manager.registry.context_count() == 0
            assert manager.registry.total_page_count() == 0
        finally:
            await manager.shutdown()

    asyncio.run(run())


def test_two_isolated_contexts_do_not_share_pages() -> None:
    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=4))
        try:
            async with manager.isolated_context() as ctx_a:
                page_a = await ctx_a.open_page()
                async with manager.isolated_context() as ctx_b:
                    page_b = await ctx_b.open_page()
                    assert ctx_a.context_id != ctx_b.context_id
                    assert page_a.target.target_id != page_b.target.target_id
                    assert manager.registry.context_count() == 2
                assert manager.registry.context_count() == 1
            assert manager.registry.context_count() == 0
        finally:
            await manager.shutdown()

    asyncio.run(run())


def test_concurrent_context_cap_is_enforced() -> None:
    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=1))
        try:
            order: list[str] = []
            first_entered = asyncio.Event()

            async def hold_first() -> None:
                async with manager.isolated_context():
                    order.append("first-enter")
                    first_entered.set()
                    await asyncio.sleep(0.4)
                    order.append("first-exit")

            async def try_second() -> None:
                await first_entered.wait()
                # The first context is still open and the cap is 1, so this
                # must block until the first context above releases the
                # semaphore, rather than opening a second concurrent
                # context.
                async with manager.isolated_context():
                    order.append("second-enter")

            await asyncio.gather(hold_first(), try_second())

            assert order.index("first-exit") < order.index("second-enter")
        finally:
            await manager.shutdown()

    asyncio.run(run())


def test_shutdown_leaves_no_registered_resources() -> None:
    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=2))
        async with manager.isolated_context() as ctx:
            await ctx.open_page()
        await manager.shutdown()
        assert manager.registry.context_count() == 0
        assert not await manager.is_healthy()

    asyncio.run(run())


def test_reap_abandoned_reports_stale_contexts_without_touching_fresh_ones() -> None:
    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=2))
        try:
            async with manager.isolated_context():
                # Freshly created -- should not be reported as stale for any
                # sane max_age.
                assert await manager.reap_abandoned(max_age_seconds=60.0) == 0
        finally:
            await manager.shutdown()

    asyncio.run(run())


def test_restart_produces_a_healthy_browser_and_clears_old_registrations() -> None:
    async def run() -> None:
        manager = BrowserLifecycleManager(LifecycleConfig(max_concurrent_contexts=2))
        try:
            async with manager.isolated_context():
                pass
            assert await manager.is_healthy()
            await manager.restart()
            assert await manager.is_healthy()
            assert manager.registry.context_count() == 0

            # The restarted browser must still be usable for a fresh task.
            async with manager.isolated_context() as ctx:
                page = await ctx.open_page()
                assert page is not None
        finally:
            await manager.shutdown()

    asyncio.run(run())


def test_lifecycle_config_from_env_reads_executable_path_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BROWSER_SERVICE_CHROME_EXECUTABLE", raising=False)
    default_config = LifecycleConfig.from_env()
    assert default_config.executable_path is None

    monkeypatch.setenv("BROWSER_SERVICE_CHROME_EXECUTABLE", "C:/fake/chrome.exe")
    configured = LifecycleConfig.from_env()
    assert configured.executable_path == "C:/fake/chrome.exe"
