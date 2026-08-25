from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from browser_service.discovery import DiscoveryService
from browser_service.discovery.service import MAX_SETTLE_SECONDS
from browser_service.endpoint_map.repository import InMemoryEndpointMapRepository
from browser_service.network.observation import (
    BodyShape,
    InitiatorCategory,
    SanitizedNetworkObservation,
)
from browser_service.sites.loader import SitePolicyLoader


def write_policy(
    root: Path, *, approved: bool = True, kill_switch_enabled: bool = False
) -> SitePolicyLoader:
    root.mkdir()
    decision = "approved" if approved else "pending"
    reviewer = (
        "reviewer: human\ndecision_date: 2026-08-24"
        if approved
        else "reviewer: null\ndecision_date: null"
    )
    (root / "local-fixture.yaml").write_text(
        f"""schema_version: 1
site_id: local-fixture
canonical_domain: localhost
allowed_subdomains: []
allowed_routes: [/api/*]
allowed_methods: [GET]
discovery_permitted: true
replay_permitted: true
data_classification: internal
retention_days: 1
owner: test
{reviewer}
decision: {decision}
review_date: 2026-08-24
kill_switch_enabled: {str(kill_switch_enabled).lower()}
""",
        encoding="utf-8",
    )
    return SitePolicyLoader(root, approval_staleness_days=None, today_fn=lambda: date(2026, 8, 24))


def observation(identifier: str, path: str) -> SanitizedNetworkObservation:
    return SanitizedNetworkObservation(
        observation_id=identifier,
        task_id="task-1",
        session_id="session-1",
        captured_at="2026-08-24T00:00:00+00:00",
        method="GET",
        origin="http://localhost:8765",
        path=path,
        query_keys=("q",),
        same_origin=True,
        status=200,
        content_type="application/json",
        timing_ms=10,
        initiator=InitiatorCategory.SCRIPT,
        request_body_shape=None,
        response_body_shape=BodyShape("object", ("products",)),
        stable_response_headers=("content-type",),
        redacted=True,
        truncated=False,
    )


def capture_factory(
    items: list[SanitizedNetworkObservation], called: list[str]
) -> Callable[..., AbstractAsyncContextManager[None]]:
    @asynccontextmanager
    async def capture(_page: Any, **kwargs: Any) -> AsyncIterator[None]:
        called.append("capture")
        sink = kwargs["sink"]
        for item in items:
            await sink(item)
        yield

    return capture


@pytest.mark.asyncio
async def test_governed_capture_infers_and_saves_pending_snapshot(tmp_path: Path) -> None:
    repository = InMemoryEndpointMapRepository()
    called: list[str] = []
    service = DiscoveryService(
        repository,
        write_policy(tmp_path / "sites"),
        capture=capture_factory(
            [observation("one", "/api/products/1"), observation("two", "/api/products/2")],
            called,
        ),
    )

    async def navigate(_page: Any, _url: str) -> None:
        called.append("navigate")

    result = await service.discover(
        object(),
        site_id="local-fixture",
        url="http://localhost:8765/",
        task_id="task-1",
        session_id="session-1",
        navigate=navigate,
    )
    assert called == ["capture", "navigate"]
    assert result.observation_count == 2
    assert result.version.operations[0].path_template == "/api/products/{var}"
    assert await repository.get_active("local-fixture") is None


@pytest.mark.asyncio
async def test_settle_wait_happens_between_navigate_and_capture_exit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """P03-F05 step 1: capture must still be attached while the bounded
    client-render settling wait runs, so late XHR/fetch calls fired after
    navigation completes are still observed."""
    repository = InMemoryEndpointMapRepository()
    called: list[str] = []
    service = DiscoveryService(
        repository,
        write_policy(tmp_path / "sites"),
        capture=capture_factory([], called),
        settle_seconds=0.01,
    )

    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        called.append("settle")

    monkeypatch.setattr("browser_service.discovery.service.asyncio.sleep", fake_sleep)

    async def navigate(_page: Any, _url: str) -> None:
        called.append("navigate")

    await service.discover(
        object(),
        site_id="local-fixture",
        url="http://localhost:8765/",
        task_id="task-1",
        session_id="session-1",
        navigate=navigate,
    )
    assert called == ["capture", "navigate", "settle"]
    assert sleeps == [0.01]


def test_settle_seconds_is_bounded_even_when_misconfigured_high(tmp_path: Path) -> None:
    service = DiscoveryService(
        InMemoryEndpointMapRepository(),
        write_policy(tmp_path / "sites"),
        settle_seconds=100.0,
    )
    assert service._settle_seconds == MAX_SETTLE_SECONDS  # noqa: SLF001


@pytest.mark.asyncio
async def test_kill_switch_blocks_before_capture_or_navigation(tmp_path: Path) -> None:
    repository = InMemoryEndpointMapRepository()
    called: list[str] = []
    service = DiscoveryService(
        repository,
        write_policy(tmp_path / "sites", kill_switch_enabled=True),
        capture=capture_factory([], called),
    )

    async def navigate(_page: Any, _url: str) -> None:
        called.append("navigate")

    with pytest.raises(PermissionError):
        await service.discover(
            object(),
            site_id="local-fixture",
            url="http://localhost:8765/",
            task_id="task-1",
            session_id=None,
            navigate=navigate,
        )
    assert called == []
