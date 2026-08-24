from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from nodriver.core.tab import Tab  # type: ignore[import-untyped]

from browser_service.endpoint_map.inference import infer_operations
from browser_service.endpoint_map.models import DriftAlert, EndpointMapVersion, Site
from browser_service.endpoint_map.repository import EndpointMapRepository
from browser_service.endpoint_map.runtime import runtime_endpoint_map_repository
from browser_service.endpoint_map.snapshots import compare_with_active, create_snapshot
from browser_service.network.capture import capture_network
from browser_service.network.observation import SanitizedNetworkObservation
from browser_service.sites.loader import SitePolicyLoader

CaptureFactory = Callable[..., AbstractAsyncContextManager[None]]
Navigate = Callable[[Tab, str], Awaitable[Any]]


@dataclass(frozen=True)
class DiscoveryResult:
    version: EndpointMapVersion
    drift_alerts: tuple[DriftAlert, ...]
    observation_count: int
    operation_count: int


class DiscoveryService:
    def __init__(
        self,
        repository: EndpointMapRepository = runtime_endpoint_map_repository,
        policies: SitePolicyLoader | None = None,
        *,
        capture: CaptureFactory = capture_network,
    ) -> None:
        self._repository = repository
        self._policies = policies or SitePolicyLoader()
        self._capture = capture

    async def discover(
        self,
        page: Tab,
        *,
        site_id: str,
        url: str,
        task_id: str,
        session_id: str | None,
        navigate: Navigate,
    ) -> DiscoveryResult:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("discovery URL must be absolute HTTP(S)")
        if not self._policies.is_capture_allowed(site_id, parsed.hostname):
            raise PermissionError("site policy blocked network discovery")
        observations: list[SanitizedNetworkObservation] = []

        async def collect(observation: SanitizedNetworkObservation) -> None:
            observations.append(observation)

        origin = f"{parsed.scheme}://{parsed.netloc}"
        async with self._capture(
            page,
            task_id=task_id,
            session_id=session_id,
            sink=collect,
            page_origin=origin,
        ):
            await navigate(page, url)

        operations = infer_operations(observations)
        active = await self._repository.get_active(site_id)
        candidate = create_snapshot(site_id, operations)
        compared, alerts = compare_with_active(candidate, active)
        await self._repository.save_site(Site(site_id, origin, compared.created_at))
        await self._repository.save_version(compared)
        return DiscoveryResult(
            version=compared,
            drift_alerts=alerts,
            observation_count=len(observations),
            operation_count=len(operations),
        )
