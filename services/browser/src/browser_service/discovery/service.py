from __future__ import annotations

import asyncio
import ipaddress
import socket
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
Resolver = Callable[[str], Awaitable[tuple[str, ...]]]

DEFAULT_SETTLE_SECONDS = 1.5
MAX_SETTLE_SECONDS = 5.0


async def _resolve(hostname: str) -> tuple[str, ...]:
    loop = asyncio.get_running_loop()
    records = await loop.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    return tuple(sorted({str(record[4][0]) for record in records}))


def _public_addresses(addresses: tuple[str, ...], *, allow_loopback: bool) -> bool:
    if not addresses:
        return False
    for raw in addresses:
        address = ipaddress.ip_address(raw)
        blocked = (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        )
        if blocked and not (allow_loopback and address.is_loopback):
            return False
    return True


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
        resolver: Resolver = _resolve,
        settle_seconds: float = DEFAULT_SETTLE_SECONDS,
    ) -> None:
        self._repository = repository
        self._policies = policies or SitePolicyLoader()
        self._capture = capture
        self._resolver = resolver
        self._settle_seconds = max(0.0, min(settle_seconds, MAX_SETTLE_SECONDS))

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
        addresses = await self._resolver(parsed.hostname)
        if not _public_addresses(addresses, allow_loopback=site_id == "local-fixture"):
            raise PermissionError("network address policy blocked discovery")
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
            # Bounded wait for client-rendered XHR/fetch calls fired after the
            # initial document settles (e.g. a React app's mount-time fetch),
            # so capture -- still attached -- observes them too. Deliberately
            # a fixed bounded sleep, not an idle-detector: simplest correct
            # implementation of "bounded client-render settling."
            if self._settle_seconds > 0:
                await asyncio.sleep(self._settle_seconds)

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
