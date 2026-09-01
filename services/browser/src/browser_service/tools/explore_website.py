"""Single-navigation, read-only website exploration tool.

**What P03-R03 changed.** One exploration used to build two independent
whole-page representations -- a full `page.get_content()` HTML
serialization *and* a full pierced `DOM.getDocument` -- and a successful
observation could not be returned unless the HTML one completed first. Both
were unbounded, and each stage owned its own independent clock, so the
stages could collectively run far past any total the caller believed in.

Now there is one server-owned total budget (:data:`EXPLORATION_BUDGET`)
divided into named sub-budgets, with remaining-budget propagation so a slow
navigation cannot leave a full-length capture behind it. The bounded
observation is the *only* required whole-page representation: it is
rendered back to HTML (see
:mod:`browser_service.page_observation.serialize`) and fed to the existing
Phase 2 extractor, so document metadata, chunks, anchors, records, and
citations all derive from content the observation actually retained. Full
HTML serialization survives only as a separately bounded optional fallback
for the case where the observation yielded no usable text at all.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import time
from typing import Any, cast
from urllib.parse import urlsplit
from uuid import uuid4

from nodriver.cdp import dom as cdp_dom

from browser_service.browser import (
    BrowserLifecycleManager,
    NavigationBlockedError,
    NavigationCancelledError,
    NavigationError,
    NavigationLimits,
    NavigationService,
    NavigationTimeoutError,
    ResponseTooLargeError,
    TooManyRedirectsError,
    UrlPolicy,
)
from browser_service.contracts import InvocationExploreWebsite
from browser_service.extraction import extract_document
from browser_service.page_observation.capabilities import classify_capabilities
from browser_service.page_observation.capture import (
    CaptureLimits,
    CaptureResult,
    CaptureUnavailableError,
    capture_page,
)
from browser_service.page_observation.cdp import BudgetClock, CdpTimeoutError, StageBudget
from browser_service.page_observation.graph import build_graph
from browser_service.page_observation.handles import ObservationStore, StoredObservation
from browser_service.page_observation.layout import BoundingBoxCapture, capture_bounding_boxes
from browser_service.page_observation.serialize import RenderedObservation, render_observed_html
from browser_service.page_observation.settle import SettleConfig, wait_for_settle
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

#: The one server-owned total budget for `browser.explore_website`, divided
#: into named sequential stages (P03-R03 step 3). Mirrored by the renderer's
#: own outer deadline in
#: `apps/renderer/src/server/browser-service/timeouts.ts`, which must stay
#: strictly larger so the layer that owns the work is the layer that reports
#: the timeout.
EXPLORATION_BUDGET = StageBudget(
    total_seconds=45.0,
    navigation_seconds=20.0,
    settle_seconds=6.0,
    capture_seconds=10.0,
    extraction_seconds=5.0,
    validation_seconds=1.0,
    cleanup_seconds=2.0,
)

#: Below this, an observation carries no citable text and no records, so
#: there is nothing a caller could safely ground an answer in. Only then is
#: an exploration reported as `TIMEOUT` rather than as partial success
#: (P03-R03 step 4).
MIN_USEFUL_CHUNKS = 1

MAX_GRAPH_NODES = 2_000


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


def _mark_context_unhealthy(context: Any, reason: str) -> None:
    """Records that this task may have left an in-flight CDP request behind.

    A request cancelled by its own deadline can still be answered later, so
    the page must be retired rather than reused, and the shared browser must
    be probed before it takes new work (P03-R05 step 3). The lifecycle
    manager owns both decisions; this only reports the evidence.
    """
    mark = getattr(context, "mark_unhealthy", None)
    if callable(mark):
        mark(reason)


async def _release_dom_domain(page: Any) -> str:
    """Stops mutation-event delivery for this page once observation is done.

    Bounded and failure-tolerant: cleanup must never replace the primary
    typed outcome (P03-R05 step 1).
    """
    try:
        async with asyncio.timeout(EXPLORATION_BUDGET.cleanup_seconds):
            await page.send(cdp_dom.disable())
        return "released"
    except (TimeoutError, CdpTimeoutError):
        return "timeout"
    except Exception:  # noqa: BLE001 -- a page already gone is a fine outcome here
        return "unavailable"


def _capture_truncations(
    captured: CaptureResult, boxes: BoundingBoxCapture, rendered: RenderedObservation
) -> list[dict[str, object]]:
    """Machine-readable coverage for every budget the capture actually hit
    (P03-R02 step 4). `PageTruncation.reason` is free text over a closed
    category set, which is what lets a new bound be reported honestly
    without widening the shared warning enum."""
    truncations: list[dict[str, object]] = []
    if captured.timed_out:
        truncations.append(
            {
                "reason": "The capture budget was exhausted before the whole page was observed.",
                "category": "nodes",
                "removedCount": captured.unexpanded_frontier_count,
            }
        )
    if captured.truncated_by_expansion_limit:
        truncations.append(
            {
                "reason": "The incremental DOM expansion limit was reached.",
                "category": "nodes",
                "removedCount": captured.unexpanded_frontier_count,
            }
        )
    if captured.truncated_by_frame_limit:
        truncations.append(
            {
                "reason": "The observed frame limit was reached.",
                "category": "nodes",
                "removedCount": 0,
            }
        )
    if captured.truncated_by_shadow_limit:
        truncations.append(
            {
                "reason": "The observed shadow-root limit was reached.",
                "category": "nodes",
                "removedCount": 0,
            }
        )
    if captured.truncated_by_response_limit:
        truncations.append(
            {
                "reason": "A single DOM response exceeded its size bound and was truncated.",
                "category": "nodes",
                "removedCount": 0,
            }
        )
    if boxes.skipped_count:
        truncations.append(
            {
                "reason": "Layout measurement did not reach every observed node within its budget.",
                "category": "nodes",
                "removedCount": boxes.skipped_count,
            }
        )
    if rendered.truncated:
        truncations.append(
            {
                "reason": "The observed document exceeded its serialization bound.",
                "category": "text",
                "removedCount": 0,
            }
        )
    return truncations


def _coverage_notes(
    captured: CaptureResult, boxes: BoundingBoxCapture, html_fallback: str
) -> list[str]:
    notes: list[str] = []
    if captured.ax_status == "partial":
        notes.append(
            "Accessibility data is partial: the full tree exceeded its budget and only scoped "
            "regions were resolved."
        )
    elif captured.ax_status == "timeout":
        notes.append("Accessibility data was not available within its budget.")
    elif captured.ax_status == "unavailable":
        notes.append("The accessibility domain was unavailable for this page.")
    if captured.unexpanded_frontier_count:
        notes.append(
            f"{captured.unexpanded_frontier_count} region(s) still had unread child content when "
            "the capture budget ended."
        )
    if boxes.skipped_count:
        notes.append(f"{boxes.skipped_count} node(s) were not measured for layout position.")
    if html_fallback == "used":
        notes.append(
            "Evidence was derived from a full page serialization after the observation "
            "yielded no text."
        )
    elif html_fallback == "timed_out":
        notes.append(
            "A full page serialization was attempted as a fallback and exceeded its budget."
        )
    return notes


def _observation_warnings(
    settle_status: str, captured: CaptureResult, graph_warnings: list[dict[str, object]]
) -> list[dict[str, object]]:
    warnings = list(graph_warnings)
    if settle_status != "complete":
        warnings.append(
            {
                "code": "settle_timeout" if settle_status == "timeout" else "settle_unstable",
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
    if captured.truncated_by_node_limit or captured.unexpanded_frontier_count:
        warnings.append(
            {
                "code": "node_limit_reached",
                "message": (
                    "The observation stopped before every node was read; the result is partial."
                ),
                "nodeHandle": None,
            }
        )
    if captured.truncated_by_frame_limit:
        warnings.append(
            {
                "code": "cross_origin_boundary",
                "message": "Some embedded frames were not observed within the frame budget.",
                "nodeHandle": None,
            }
        )
    if captured.truncated_by_shadow_limit:
        warnings.append(
            {
                "code": "closed_shadow_boundary",
                "message": "Some shadow roots were not observed within the shadow-root budget.",
                "nodeHandle": None,
            }
        )
    return warnings


async def run_explore_website(
    invocation: InvocationExploreWebsite,
    cancelled: asyncio.Event,
    *,
    policy: UrlPolicy | None = None,
    manager: BrowserLifecycleManager | None = None,
    budget: StageBudget | None = None,
) -> ToolHandlerOutcome:
    manager = manager if manager is not None else await get_lifecycle_manager()
    url_policy = policy if policy is not None else UrlPolicy()
    stage_budget = budget if budget is not None else EXPLORATION_BUDGET
    clock = BudgetClock(stage_budget)
    total_start = time.monotonic()

    async with manager.isolated_context() as context:
        page = await context.open_page()
        cleanup_outcome = "skipped"
        try:
            # -- navigation -------------------------------------------------
            nav_start = time.monotonic()
            navigation = NavigationService(
                url_policy,
                NavigationLimits(
                    total_timeout_seconds=clock.stage_seconds(stage_budget.navigation_seconds)
                ),
            )
            try:
                nav = await navigation.navigate(page, invocation.arguments.url, cancelled=cancelled)
            except (NavigationError, NavigationBlockedError) as exc:
                raise _navigation_error(exc) from exc
            navigation_ms = (time.monotonic() - nav_start) * 1000

            observation_start = time.monotonic()
            try:
                # -- settle -------------------------------------------------
                settle_seconds = max(0.1, clock.stage_seconds(stage_budget.settle_seconds))
                settle = await wait_for_settle(
                    page,
                    SettleConfig(
                        max_settle_seconds=settle_seconds,
                        # Remaining-budget propagation can hand this stage far
                        # less than its ceiling. A quiet window wider than the
                        # budget could never elapse, so a calm page would be
                        # reported as `timeout` purely because an earlier
                        # stage ran long.
                        quiet_window_seconds=min(
                            SettleConfig().quiet_window_seconds, settle_seconds / 2
                        ),
                    ),
                )

                # -- capture ------------------------------------------------
                capture_seconds = clock.stage_seconds(stage_budget.capture_seconds)
                if capture_seconds <= 0:
                    raise ToolExecutionError(
                        "TIMEOUT", "Website exploration timed out.", retryable=True
                    )
                captured = await capture_page(page, CaptureLimits(timeout_seconds=capture_seconds))
            except CaptureUnavailableError as exc:
                # The document itself never arrived, so there is no bounded
                # observation to be partial about, and the request that never
                # answered may still be in flight.
                _mark_context_unhealthy(context, "capture_document_timeout")
                raise ToolExecutionError(
                    "TIMEOUT", "Website exploration timed out.", retryable=True
                ) from exc
            except asyncio.CancelledError:
                _mark_context_unhealthy(context, "cancelled_mid_observation")
                raise
            except (NavigationError, NavigationCancelledError, NavigationTimeoutError) as exc:
                raise _navigation_error(exc) from exc

            graph = build_graph(
                captured.root,
                captured.ax_by_backend_id,
                page_url=nav.final_url,
                page_origin=f"{urlsplit(nav.final_url).scheme}://{urlsplit(nav.final_url).netloc}",
                max_nodes=MAX_GRAPH_NODES,
            )
            boxes = await capture_bounding_boxes(
                page,
                list(graph.backend_id_by_handle.values()),
                budget_seconds=max(0.1, clock.stage_seconds(stage_budget.capture_seconds)),
            )
            if captured.timed_out or boxes.timed_out:
                _mark_context_unhealthy(context, "cdp_request_deadline")
            for node in graph.nodes:
                backend_id = graph.backend_id_by_handle.get(str(node["handle"]))
                node["boundingBox"] = (
                    boxes.boxes.get(backend_id) if backend_id is not None else None
                )
            observation_ms = (time.monotonic() - observation_start) * 1000

            # -- extraction, from the observation rather than a second
            #    whole-page serialization (P03-R03 steps 1-2) --------------
            extraction_start = time.monotonic()
            rendered = render_observed_html(captured.root)
            document = extract_document(
                rendered.html,
                nav.final_url,
                accessibility_nodes=captured.raw_ax_nodes,
                accessibility_available=captured.ax_available,
                dom_tag_by_backend_id=captured.dom_tag_by_backend_id,
            )

            # Optional, separately bounded fallback: only when the
            # observation produced no citable text at all, and only with
            # budget still to spend. This is the sole path on which a full
            # page serialization is ever requested.
            html_fallback = "not_needed"
            if len(document.chunks) < MIN_USEFUL_CHUNKS:
                fallback_seconds = clock.stage_seconds(stage_budget.extraction_seconds)
                if fallback_seconds > 0:
                    html_fallback = "timed_out"
                    with contextlib.suppress(
                        NavigationError,
                        NavigationTimeoutError,
                        NavigationCancelledError,
                        ResponseTooLargeError,
                        TimeoutError,
                    ):
                        # Bounded here as well as inside the navigation
                        # service: this stage is optional, so its ceiling
                        # belongs to the exploration that chose to attempt
                        # it, not only to the service performing it.
                        async with asyncio.timeout(fallback_seconds):
                            content = await NavigationService(
                                url_policy,
                                NavigationLimits(total_timeout_seconds=fallback_seconds),
                            ).get_content(page, cancelled=cancelled)
                        if content.content:
                            document = extract_document(
                                content.content,
                                nav.final_url,
                                accessibility_nodes=captured.raw_ax_nodes,
                                accessibility_available=captured.ax_available,
                                dom_tag_by_backend_id=captured.dom_tag_by_backend_id,
                            )
                            html_fallback = "used"
            extraction_ms = (time.monotonic() - extraction_start) * 1000
        finally:
            cleanup_outcome = await _release_dom_domain(page)

    capabilities, coverage = classify_capabilities(graph.nodes, graph.relationships)

    # -- partial-success threshold (P03-R03 step 4) ------------------------
    has_records = bool(graph.collections) or bool(graph.nodes)
    if len(document.chunks) < MIN_USEFUL_CHUNKS and not has_records:
        raise ToolExecutionError("TIMEOUT", "Website exploration timed out.", retryable=True)

    warnings = _observation_warnings(settle.status, captured, list(graph.warnings))
    truncations = list(graph.truncations) + _capture_truncations(captured, boxes, rendered)

    coverage = dict(coverage)
    inaccessible_before = coverage.get("inaccessibleRegionCount", 0)
    coverage["inaccessibleRegionCount"] = (
        int(inaccessible_before) if isinstance(inaccessible_before, int) else 0
    ) + captured.unexpanded_frontier_count
    existing_notes = list(cast(list[str], coverage.get("notes", [])))
    coverage["notes"] = (existing_notes + _coverage_notes(captured, boxes, html_fallback))[:8]

    status = settle.status
    if captured.partial or boxes.skipped_count or rendered.truncated:
        status = "partial"

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
        "truncations": truncations,
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
    # Cleanup outcome is observable to the service's own logs only -- never
    # part of the payload the model or renderer reads.
    _ = cleanup_outcome
    return ToolHandlerOutcome(payload=payload, evidence=build_evidence(document, nav.final_url))


__all__ = ["EXPLORATION_BUDGET", "OBSERVATIONS", "run_explore_website"]
