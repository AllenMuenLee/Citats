"""Single-navigation, read-only website exploration tool."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from typing import Any, cast
from urllib.parse import urlsplit
from uuid import uuid4

from browser_service.browser import (
    BrowserLifecycleManager,
    NavigationBlockedError,
    NavigationCancelledError,
    NavigationError,
    NavigationService,
    NavigationTimeoutError,
    ResponseTooLargeError,
    TooManyRedirectsError,
    UrlPolicy,
)
from browser_service.contracts import InvocationExploreWebsite
from browser_service.extraction import extract_document
from browser_service.page_observation.capabilities import classify_capabilities
from browser_service.page_observation.capture import capture_page
from browser_service.page_observation.graph import build_graph
from browser_service.page_observation.handles import ObservationStore, StoredObservation
from browser_service.page_observation.layout import fetch_bounding_boxes
from browser_service.page_observation.settle import wait_for_settle
from browser_service.tool_outcome import ToolExecutionError, ToolHandlerOutcome
from browser_service.tools._document_wire import (
    accessibility_to_wire,
    build_evidence,
    chunk_to_wire,
    metadata_to_wire,
    truncation_to_wire,
    warning_to_wire,
)
from browser_service.tools._lifecycle import get_lifecycle_manager

OBSERVATIONS = ObservationStore()


def _navigation_error(exc: Exception) -> ToolExecutionError:
    if isinstance(exc, NavigationBlockedError):
        return ToolExecutionError(
            "INVALID_ARGUMENTS", "The URL was blocked by navigation policy.", retryable=False
        )
    if isinstance(exc, NavigationCancelledError):
        return ToolExecutionError("CANCELLED", "Navigation was cancelled.", retryable=True)
    if isinstance(exc, NavigationTimeoutError):
        return ToolExecutionError("TIMEOUT", "Website exploration timed out.", retryable=True)
    if isinstance(exc, (TooManyRedirectsError, ResponseTooLargeError)):
        return ToolExecutionError(
            "UPSTREAM_UNAVAILABLE", "The page could not be safely retrieved.", retryable=False
        )
    return ToolExecutionError(
        "UPSTREAM_UNAVAILABLE", "The page could not be retrieved.", retryable=True
    )


async def run_explore_website(
    invocation: InvocationExploreWebsite,
    cancelled: asyncio.Event,
    *,
    policy: UrlPolicy | None = None,
    manager: BrowserLifecycleManager | None = None,
) -> ToolHandlerOutcome:
    manager = manager if manager is not None else await get_lifecycle_manager()
    navigation = NavigationService(policy if policy is not None else UrlPolicy())
    total_start = time.monotonic()
    async with manager.isolated_context() as context:
        page = await context.open_page()
        nav_start = time.monotonic()
        try:
            nav = await navigation.navigate(page, invocation.arguments.url, cancelled=cancelled)
        except (NavigationError, NavigationBlockedError) as exc:
            raise _navigation_error(exc) from exc
        navigation_ms = (time.monotonic() - nav_start) * 1000

        try:
            settle = await wait_for_settle(page)
            content = await navigation.get_content(page, cancelled=cancelled)
            observation_start = time.monotonic()
            captured = await capture_page(page)
            graph = build_graph(
                captured.root,
                captured.ax_by_backend_id,
                page_url=nav.final_url,
                page_origin=f"{urlsplit(nav.final_url).scheme}://{urlsplit(nav.final_url).netloc}",
                max_nodes=2_000,
            )
            boxes = await fetch_bounding_boxes(page, list(graph.backend_id_by_handle.values()))
        except (NavigationError, NavigationCancelledError, NavigationTimeoutError) as exc:
            raise _navigation_error(exc) from exc

        for node in graph.nodes:
            backend_id = graph.backend_id_by_handle.get(str(node["handle"]))
            node["boundingBox"] = boxes.get(backend_id) if backend_id is not None else None
        observation_ms = (time.monotonic() - observation_start) * 1000

    extraction_start = time.monotonic()
    document = extract_document(
        content.content or "",
        nav.final_url,
        accessibility_nodes=captured.raw_ax_nodes,
        accessibility_available=captured.ax_available,
        dom_tag_by_backend_id=captured.dom_tag_by_backend_id,
    )
    extraction_ms = (time.monotonic() - extraction_start) * 1000
    capabilities, coverage = classify_capabilities(graph.nodes, graph.relationships)
    warnings = list(graph.warnings)
    status = settle.status
    if captured.truncated_by_node_limit or captured.truncated_by_depth:
        status = "partial"
    if settle.status != "complete":
        warnings.append(
            {
                "code": "settle_timeout" if settle.status == "timeout" else "settle_unstable",
                "message": (
                    "The rendered page did not reach a stable quiet state within its "
                    "bounded settle window."
                ),
                "nodeHandle": None,
            }
        )
    if captured.truncated_by_depth:
        warnings.append(
            {
                "code": "depth_limit_reached",
                "message": "The observation depth limit was reached.",
                "nodeHandle": None,
            }
        )

    observation_id = f"obs-{uuid4().hex}"
    parsed = urlsplit(nav.final_url)
    page_graph: dict[str, Any] = {
        "schemaVersion": 1,
        "observationId": observation_id,
        "metadata": {
            "finalUrl": nav.final_url,
            "origin": f"{parsed.scheme}://{parsed.netloc}",
            "title": document.metadata.title,
            "language": document.metadata.language,
            "description": document.metadata.description,
            "author": document.metadata.author,
            "publishedTime": document.metadata.published_time,
            "updatedTime": document.metadata.updated_time,
            "favicon": None,
            "themeColor": None,
            "viewportHint": None,
            "documentDirection": None,
            "contentType": None,
            "charset": None,
            "robots": None,
        },
        "status": status,
        "nodes": graph.nodes,
        "relationships": graph.relationships,
        "regions": graph.regions,
        "collections": graph.collections,
        "capabilities": capabilities,
        "sourceCandidates": graph.source_candidates,
        "viewport": {
            "width": 0,
            "height": 0,
            "scrollX": 0,
            "scrollY": 0,
            "scrollHeight": 0,
            "devicePixelRatio": None,
        },
        "warnings": warnings,
        "truncations": graph.truncations,
        "coverage": coverage,
        "observationDigest": "",
        "untrusted": True,
    }
    digest_source = json.dumps(
        page_graph, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    page_graph["observationDigest"] = f"sha256-{hashlib.sha256(digest_source.encode()).hexdigest()}"

    OBSERVATIONS.put(
        StoredObservation(
            observation_id=observation_id,
            session_id=invocation.correlation.sessionId or "",
            owner_id=invocation.correlation.userId,
            nodes_by_handle={str(n["handle"]): n for n in graph.nodes},
            relationships_by_from_handle={
                h: [e for e in graph.relationships if e.get("from") == h]
                for h in {str(n["handle"]) for n in graph.nodes}
            },
            region_child_handles={
                str(r["handle"]): list(cast(list[str], r["childHandles"])) for r in graph.regions
            },
            collection_record_handles={
                str(c["handle"]): list(cast(list[str], c["recordHandles"]))
                for c in graph.collections
            },
        )
    )
    payload = {
        "document": {
            "metadata": metadata_to_wire(document.metadata, None, None),
            "accessibility": [accessibility_to_wire(n) for n in document.accessibility],
            "chunks": [chunk_to_wire(c) for c in document.chunks],
            "warnings": [warning_to_wire(w) for w in document.warnings],
            "truncations": [truncation_to_wire(t) for t in document.truncations],
        },
        "pageUnderstanding": page_graph,
        "timing": {
            "navigationMs": navigation_ms,
            "extractionMs": extraction_ms,
            "observationMs": observation_ms,
            "totalMs": (time.monotonic() - total_start) * 1000,
        },
        "untrusted": True,
    }
    return ToolHandlerOutcome(payload=payload, evidence=build_evidence(document, nav.final_url))


__all__ = ["OBSERVATIONS", "run_explore_website"]
