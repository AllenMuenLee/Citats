from __future__ import annotations

import asyncio
from typing import Any

import httpx

from browser_service.contracts import InvocationInvokeDiscoveredApi
from browser_service.discovered_api import DiscoveredApiError, DiscoveredApiInvoker
from browser_service.endpoint_map.runtime import runtime_endpoint_map_repository
from browser_service.sites.loader import SitePolicyLoader
from browser_service.tool_outcome import ToolExecutionError, ToolHandlerOutcome

_invoker: DiscoveredApiInvoker | None = None


def configure_discovered_api_invoker(invoker: DiscoveredApiInvoker | None) -> None:
    global _invoker
    _invoker = invoker


def _default_invoker() -> DiscoveredApiInvoker:
    global _invoker
    if _invoker is None:
        _invoker = DiscoveredApiInvoker(
            runtime_endpoint_map_repository,
            SitePolicyLoader(),
            httpx.AsyncClient(follow_redirects=False),
        )
    return _invoker


async def run_invoke_discovered_api(
    invocation: InvocationInvokeDiscoveredApi,
    cancelled: asyncio.Event,
) -> ToolHandlerOutcome:
    try:
        result = await _default_invoker().invoke(
            invocation.arguments.siteId,
            invocation.arguments.operationId,
            invocation.arguments.model_dump()["parameters"],
            cancelled=cancelled,
        )
    except DiscoveredApiError as exc:
        raise ToolExecutionError(exc.code, exc.message, retryable=exc.retryable) from exc
    source_id = f"{result.site_id}-{result.operation_id}"[:128]
    payload: dict[str, Any] = {
        "siteId": result.site_id,
        "operationId": result.operation_id,
        "mapVersion": result.map_version,
        "resultKind": result.result_kind,
        "records": list(result.records),
        "sources": [
            {
                "sourceId": source_id,
                "title": f"{result.site_id} API result",
                "url": result.source_url,
            }
        ],
        "retrievedAt": result.retrieved_at,
        "staleAfter": result.stale_after,
        "warnings": list(result.warnings),
        "redacted": result.redacted,
        "truncated": result.truncated,
        "untrusted": True,
    }
    evidence = [
        {
            "sourceUrl": result.source_url,
            "title": f"{result.site_id} API result",
            "snippet": f"Read-only API result with {len(result.records)} bounded records.",
            "retrievedAt": result.retrieved_at,
        }
    ]
    return ToolHandlerOutcome(payload=payload, evidence=evidence)


async def get_discovered_tool_definitions() -> tuple[dict[str, Any], ...]:
    return await _default_invoker().definitions_all()


def get_default_invoker() -> DiscoveredApiInvoker:
    """The one process-wide `DiscoveredApiInvoker` (same singleton this
    module's own handler uses), for other tools (e.g.
    `browser.navigate_extract_and_discover`) that need to build read-only
    operation definitions for a single, just-discovered site without
    constructing a second httpx client / policy loader.
    """
    return _default_invoker()


__all__ = [
    "configure_discovered_api_invoker",
    "get_default_invoker",
    "get_discovered_tool_definitions",
    "run_invoke_discovered_api",
]
