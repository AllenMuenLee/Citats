from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from browser_service.discovery import DiscoveryService
from browser_service.endpoint_map.repository import InMemoryEndpointMapRepository
from browser_service.network.observation import (
    BodyShape,
    InitiatorCategory,
    SanitizedNetworkObservation,
)
from browser_service.sites.loader import SitePolicyLoader


def write_policy(root: Path, *, approved: bool = True) -> SitePolicyLoader:
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
kill_switch_enabled: false
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
async def test_missing_approval_blocks_before_capture_or_navigation(tmp_path: Path) -> None:
    repository = InMemoryEndpointMapRepository()
    called: list[str] = []
    service = DiscoveryService(
        repository,
        write_policy(tmp_path / "sites", approved=False),
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
