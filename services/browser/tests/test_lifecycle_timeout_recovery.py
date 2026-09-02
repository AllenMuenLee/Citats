"""P03-R05 validation: repeated success/timeout/cancel cycles, handler /
task / page / context counts, post-timeout recovery, no event-loop
starvation, bounded cleanup time, and no cross-task state leakage.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any, cast

import pytest
from playwright.async_api import Browser
from tests.fixtures.accommodation_dom import (
    LISTING_COUNT,
    ax_nodes_for_results,
    build_results_document,
)
from tests.test_explore_website_pipeline import (
    TEST_BUDGET,
    FakeNavigation,
    FakePage,
    invocation,
)

from browser_service.browser.lifecycle import (
    LifecycleConfig,
    _bounded_cleanup,
)
from browser_service.page_observation.cdp import CdpSession, CdpTimeoutError, send_bounded
from browser_service.tool_outcome import ToolExecutionError
from browser_service.tools import explore_website as module


class RecordingContext:
    """An isolated context that records the health verdict task code gave it."""

    def __init__(self, page: FakePage) -> None:
        self._page = page
        self.unhealthy_reason: str | None = None
        self.pages_opened = 0

    def mark_unhealthy(self, reason: str) -> None:
        if self.unhealthy_reason is None:
            self.unhealthy_reason = reason[:80]

    @property
    def unhealthy(self) -> bool:
        return self.unhealthy_reason is not None

    async def open_page(self) -> FakePage:
        self.pages_opened += 1
        return self._page

    async def open_cdp_session(self, page: FakePage) -> FakePage:
        return page


class RecordingManager:
    def __init__(self, pages: list[FakePage]) -> None:
        self._pages = list(pages)
        self.contexts: list[RecordingContext] = []
        self.open_count = 0
        self.closed_count = 0

    @contextlib.asynccontextmanager
    async def isolated_context(self) -> Any:
        page = self._pages.pop(0)
        context = RecordingContext(page)
        self.contexts.append(context)
        self.open_count += 1
        try:
            yield context
        finally:
            self.closed_count += 1


def healthy_page() -> FakePage:
    return FakePage(document=build_results_document(), ax_nodes=ax_nodes_for_results())


def stalled_page() -> FakePage:
    return FakePage(document=build_results_document(), stall=frozenset({"DOM.getDocument"}))


async def run(manager: RecordingManager, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(module, "NavigationService", FakeNavigation)
    return await module.run_explore_website(
        invocation(), asyncio.Event(), manager=manager, budget=TEST_BUDGET  # type: ignore[arg-type]
    )


# --------------------------------------------------------------------------
# Steps 1-2: bounded cleanup that never replaces the primary error
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cleanup_is_bounded_and_never_raises() -> None:
    async def never_returns() -> None:
        await asyncio.sleep(3_600)

    async def explodes() -> None:
        raise RuntimeError("target already closed")

    async def succeeds() -> None:
        return None

    started = asyncio.get_running_loop().time()
    assert await _bounded_cleanup(never_returns(), 0.2, "page.close") is False
    assert asyncio.get_running_loop().time() - started < 2
    assert await _bounded_cleanup(explodes(), 1.0, "page.close") is False
    assert await _bounded_cleanup(succeeds(), 1.0, "page.close") is True


@pytest.mark.asyncio
async def test_a_timeout_still_releases_handlers_and_the_dom_domain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = stalled_page()
    manager = RecordingManager([page])

    async with asyncio.timeout(20):
        with pytest.raises(ToolExecutionError) as excinfo:
            await run(manager, monkeypatch)

    # The primary typed error survives cleanup.
    assert excinfo.value.code == "TIMEOUT"
    assert "DOM.disable" in page.methods
    assert len(page.removed) == len(page.handlers) > 0
    assert manager.closed_count == 1


@pytest.mark.asyncio
async def test_cancellation_releases_the_context_and_marks_it_unhealthy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = stalled_page()
    manager = RecordingManager([page])
    monkeypatch.setattr(module, "NavigationService", FakeNavigation)

    task = asyncio.create_task(
        module.run_explore_website(
            invocation(), asyncio.Event(), manager=manager, budget=TEST_BUDGET  # type: ignore[arg-type]
        )
    )
    await asyncio.sleep(0.2)
    task.cancel()
    async with asyncio.timeout(5):
        with pytest.raises(asyncio.CancelledError):
            await task

    assert manager.closed_count == 1
    assert manager.contexts[0].unhealthy_reason == "cancelled_mid_observation"


# --------------------------------------------------------------------------
# Step 3: a session that may be corrupted is retired, never reused
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_cdp_deadline_marks_the_context_for_retirement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = stalled_page()
    manager = RecordingManager([page])

    async with asyncio.timeout(20):
        with pytest.raises(ToolExecutionError):
            await run(manager, monkeypatch)

    assert manager.contexts[0].unhealthy_reason == "capture_document_timeout"


@pytest.mark.asyncio
async def test_a_clean_exploration_leaves_the_context_healthy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = RecordingManager([healthy_page()])
    await run(manager, monkeypatch)
    assert manager.contexts[0].unhealthy is False


@pytest.mark.asyncio
async def test_an_unhealthy_context_probes_the_browser_and_replaces_it_only_if_it_fails() -> None:
    from browser_service.browser.lifecycle import BrowserLifecycleManager

    class FakeBrowser:
        """Stands in for a Playwright ``Browser`` for the health probe only.

        The probe opens and closes one throwaway context: that is the single
        bounded round trip that decides whether the process still answers.
        """

        def __init__(self, *, answers: bool) -> None:
            self.answers = answers
            self.probes = 0

        def is_connected(self) -> bool:
            return True

        async def new_context(self) -> Any:
            self.probes += 1
            if not self.answers:
                await asyncio.sleep(3_600)

            class _Context:
                async def close(self) -> None:
                    return None

            return _Context()

    manager = BrowserLifecycleManager(
        LifecycleConfig(health_probe_timeout_seconds=0.2, cleanup_timeout_seconds=0.2)
    )
    restarts: list[int] = []

    async def fake_restart() -> None:
        restarts.append(1)

    manager.restart = fake_restart  # type: ignore[method-assign]

    healthy = FakeBrowser(answers=True)
    manager._browser = cast(Browser, healthy)
    assert await manager._retire_if_unhealthy("cdp_request_deadline") is False
    assert healthy.probes == 1
    assert restarts == []

    # One bounded probe decides it -- never a retry loop.
    broken = FakeBrowser(answers=False)
    manager._browser = cast(Browser, broken)
    started = asyncio.get_running_loop().time()
    assert await manager._retire_if_unhealthy("cdp_request_deadline") is True
    assert asyncio.get_running_loop().time() - started < 2
    assert broken.probes == 1
    assert restarts == [1]


# --------------------------------------------------------------------------
# Steps 5-6: recovery, no leakage, no starvation
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_timeout_is_followed_by_a_successful_exploration_without_restart(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = RecordingManager([stalled_page(), healthy_page()])

    async with asyncio.timeout(20):
        with pytest.raises(ToolExecutionError):
            await run(manager, monkeypatch)
        outcome = await run(manager, monkeypatch)

    # The service kept working, and the second exploration is complete --
    # not degraded by the first one's failure.
    assert outcome.payload["pageUnderstanding"]["status"] == "complete"
    assert outcome.payload["document"]["chunks"]
    assert manager.open_count == manager.closed_count == 2


@pytest.mark.asyncio
async def test_repeated_success_timeout_cancel_cycles_leak_no_tasks_or_contexts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "NavigationService", FakeNavigation)
    baseline_tasks = len(asyncio.all_tasks())

    for _ in range(3):
        ok = RecordingManager([healthy_page()])
        await run(ok, monkeypatch)
        assert ok.open_count == ok.closed_count == 1

        bad = RecordingManager([stalled_page()])
        async with asyncio.timeout(20):
            with pytest.raises(ToolExecutionError):
                await run(bad, monkeypatch)
        assert bad.open_count == bad.closed_count == 1

        cancelled = RecordingManager([stalled_page()])
        task = asyncio.create_task(
            module.run_explore_website(
                invocation(), asyncio.Event(), manager=cancelled, budget=TEST_BUDGET  # type: ignore[arg-type]
            )
        )
        await asyncio.sleep(0.1)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        assert cancelled.closed_count == 1

    await asyncio.sleep(0)
    # No task accumulation across nine cycles.
    assert len(asyncio.all_tasks()) <= baseline_tasks + 1


@pytest.mark.asyncio
async def test_a_stalled_task_does_not_starve_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "NavigationService", FakeNavigation)
    ticks = 0

    async def heartbeat() -> None:
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0.01)

    beat = asyncio.create_task(heartbeat())
    manager = RecordingManager([stalled_page()])
    async with asyncio.timeout(20):
        with pytest.raises(ToolExecutionError):
            await run(manager, monkeypatch)
    beat.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await beat

    # A stalled CDP request must be a *waiting* task, not a spinning one.
    assert ticks > 10


@pytest.mark.asyncio
async def test_no_observation_state_leaks_between_tasks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = RecordingManager([healthy_page()])
    second = RecordingManager([healthy_page()])

    first_outcome = await run(first, monkeypatch)
    second_outcome = await run(second, monkeypatch)

    first_id = first_outcome.payload["pageUnderstanding"]["observationId"]
    second_id = second_outcome.payload["pageUnderstanding"]["observationId"]
    assert first_id != second_id
    assert first.contexts[0] is not second.contexts[0]
    # Each task saw its own six records, not the other's.
    for outcome in (first_outcome, second_outcome):
        blob = " ".join(chunk["text"] for chunk in outcome.payload["document"]["chunks"])
        assert blob.count("per night") == LISTING_COUNT


@pytest.mark.asyncio
async def test_send_bounded_leaves_no_pending_state_behind_after_a_deadline() -> None:
    """A response arriving after its request's deadline must not mutate the
    task that gave up on it (P03-R05 step 2)."""
    late_deliveries: list[str] = []

    class LateSession:
        async def send(self, method: str, params: dict[str, Any] | None = None) -> Any:
            await asyncio.sleep(0.3)
            late_deliveries.append("delivered")
            return {"late": True}

    session = cast(CdpSession, LateSession())
    with pytest.raises(CdpTimeoutError):
        await send_bounded(
            session, "DOM.enable", timeout_seconds=0.05, phase="dom.enable"
        )

    await asyncio.sleep(0.5)
    # The cancelled request never completed, so nothing was delivered into a
    # task that had already moved on.
    assert late_deliveries == []
