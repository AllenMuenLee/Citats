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
import logging
import time
from typing import Any, cast
from urllib.parse import urlsplit
from uuid import uuid4

from browser_service.browser import (
    BrowserLifecycleManager,
    NavigationBlockedError,
    NavigationCancelledError,
    NavigationError,
    NavigationInterceptionLostError,
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
from browser_service.page_observation.cdp import (
    BudgetClock,
    CdpSession,
    CdpTimeoutError,
    StageBudget,
)
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

logger = logging.getLogger("browser_service.tools.explore_website")

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

#: Every bounded array in `success-result-explore-website.schema.json`, with
#: the bound that schema declares.
#:
#: These are not extra caution on top of the contract -- they *are* the
#: contract, restated where the payload is built. The graph builder's own
#: node ceiling used to be 2000 against a contract that allows 400, which
#: stayed invisible only because no capture had ever been rich enough to
#: exceed 400: the driver timed out on exactly the large pages that would
#: have. Once captures started succeeding, a good observation of a real
#: search page produced ~770 nodes and the whole result was rejected at the
#: bridge as a contract violation -- reported to the caller as `INTERNAL`,
#: which describes a defect rather than the bounded-observation outcome the
#: contract already has vocabulary for.
#:
#: Trimming is therefore preferred over failing, and every trim is declared
#: in `truncations` so a caller can tell a complete observation from a
#: clipped one.
CONTRACT_LIMITS = {
    "capabilities": 150,
    "collections": 20,
    "nodes": 400,
    "regions": 60,
    "relationships": 800,
    "sourceCandidates": 40,
    "truncations": 50,
    "warnings": 100,
}
DOCUMENT_LIMITS = {
    "accessibility": 1_500,
    "chunks": 50,
    "truncations": 50,
    "warnings": 100,
}

MAX_GRAPH_NODES = CONTRACT_LIMITS["nodes"]
#: Share of the node budget held back from the DOM traversal for repeated
#: records -- see `build_graph`'s `record_reserve`. A quarter is enough for
#: the twenty-odd cards a results page shows without meaningfully starving
#: the traversal that finds them.
GRAPH_RECORD_RESERVE = MAX_GRAPH_NODES // 4


def _clip(
    values: list[Any],
    limit: int,
    category: str,
    truncations: list[dict[str, Any]],
) -> list[Any]:
    """Trims one list to its contract bound, declaring what was removed.

    ``category`` must be one of the truncation categories the contract
    allows; a list with no matching category is trimmed silently, because an
    undeclarable truncation is still better than a rejected payload.
    """
    if len(values) <= limit:
        return values
    removed = len(values) - limit
    if category:
        truncations.append(
            {
                "category": category,
                "reason": f"Trimmed to the contract bound of {limit} for this collection.",
                "removedCount": removed,
            }
        )
    return values[:limit]


def _navigation_error(exc: Exception) -> ToolExecutionError:
    if isinstance(exc, NavigationBlockedError):
        return ToolExecutionError(
            "INVALID_ARGUMENTS", "The URL was blocked by navigation policy.", retryable=False
        )
    if isinstance(exc, NavigationCancelledError):
        return ToolExecutionError("CANCELLED", "Navigation was cancelled.", retryable=True)
    if isinstance(exc, NavigationTimeoutError):
        return ToolExecutionError("TIMEOUT", "Website exploration timed out.", retryable=True)
    if isinstance(exc, NavigationInterceptionLostError):
        # Not a timeout: the redirect chain could not be policed and the tab
        # is unusable. Retryable -- the same URL can succeed once it stops
        # redirecting cross-origin, and reporting it as permanent would be
        # a claim about the site this service cannot make.
        return ToolExecutionError(
            "UPSTREAM_UNAVAILABLE",
            "The page redirected in a way this browser session could not follow safely.",
            retryable=True,
        )
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


async def _release_dom_domain(session: CdpSession | None) -> str:
    """Stops mutation-event delivery for this page once observation is done.

    Bounded and failure-tolerant: cleanup must never replace the primary
    typed outcome (P03-R05 step 1).
    """
    try:
        async with asyncio.timeout(EXPLORATION_BUDGET.cleanup_seconds):
            if session is None:
                return "skipped"
            await session.send("DOM.disable")
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
        session: CdpSession | None = None
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
                if isinstance(exc, NavigationInterceptionLostError):
                    # The renderer is holding a paused document it will never
                    # receive, so this page answers no further CDP command and
                    # the shared browser must be probed before it takes new work.
                    _mark_context_unhealthy(context, "interception_lost")
                    logger.warning(
                        "browser_service.explore.interception_lost",
                        extra={
                            "requestId": invocation.correlation.requestId,
                            "stage": exc.stage,
                            "elapsedSeconds": round(time.monotonic() - total_start, 2),
                        },
                    )
                raise _navigation_error(exc) from exc
            navigation_ms = (time.monotonic() - nav_start) * 1000
            logger.info(
                "browser_service.explore.navigated",
                extra={
                    "requestId": invocation.correlation.requestId,
                    "origin": f"{urlsplit(nav.final_url).scheme}://{urlsplit(nav.final_url).netloc}",
                    "navigationMs": round(navigation_ms),
                    "remainingSeconds": round(clock.total_remaining_seconds, 2),
                },
            )

            observation_start = time.monotonic()
            try:
                # -- settle -------------------------------------------------
                settle_seconds = max(0.1, clock.stage_seconds(stage_budget.settle_seconds))
                observation_session = await context.open_cdp_session(page)
                session = observation_session
                settle = await wait_for_settle(
                    observation_session,
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

                logger.info(
                    "browser_service.explore.settled",
                    extra={
                        "requestId": invocation.correlation.requestId,
                        "settleStatus": settle.status,
                        "settleBudgetSeconds": round(settle_seconds, 2),
                        "remainingSeconds": round(clock.total_remaining_seconds, 2),
                    },
                )

                # -- capture ------------------------------------------------
                capture_seconds = clock.stage_seconds(stage_budget.capture_seconds)
                if capture_seconds <= 0:
                    logger.warning(
                        "browser_service.explore.timeout",
                        extra={
                            "requestId": invocation.correlation.requestId,
                            "stage": "capture_budget_exhausted",
                            "elapsedSeconds": round(time.monotonic() - total_start, 2),
                        },
                    )
                    raise ToolExecutionError(
                        "TIMEOUT", "Website exploration timed out.", retryable=True
                    )
                captured = await capture_page(
                    observation_session, CaptureLimits(timeout_seconds=capture_seconds)
                )
            except CaptureUnavailableError as exc:
                # The document itself never arrived, so there is no bounded
                # observation to be partial about, and the request that never
                # answered may still be in flight.
                _mark_context_unhealthy(context, "capture_document_timeout")
                logger.warning(
                    "browser_service.explore.timeout",
                    extra={
                        "requestId": invocation.correlation.requestId,
                        "stage": "capture_document_unavailable",
                        "captureBudgetSeconds": round(capture_seconds, 2),
                        "elapsedSeconds": round(time.monotonic() - total_start, 2),
                    },
                )
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
                record_reserve=GRAPH_RECORD_RESERVE,
            )
            boxes = await capture_bounding_boxes(
                observation_session,
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
            logger.info(
                "browser_service.explore.captured",
                extra={
                    "requestId": invocation.correlation.requestId,
                    "observationMs": round(observation_ms),
                    "capturePartial": captured.partial,
                    "captureTimedOut": captured.timed_out,
                    "graphNodes": len(graph.nodes),
                    "graphCollections": len(graph.collections),
                    "boxesSkipped": boxes.skipped_count,
                    "remainingSeconds": round(clock.total_remaining_seconds, 2),
                },
            )

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
            logger.info(
                "browser_service.explore.extracted",
                extra={
                    "requestId": invocation.correlation.requestId,
                    "extractionMs": round(extraction_ms),
                    "chunks": len(document.chunks),
                    "htmlFallback": html_fallback,
                    "remainingSeconds": round(clock.total_remaining_seconds, 2),
                },
            )
        finally:
            cleanup_outcome = await _release_dom_domain(session)

    capabilities, coverage = classify_capabilities(graph.nodes, graph.relationships)

    # -- partial-success threshold (P03-R03 step 4) ------------------------
    has_records = bool(graph.collections) or bool(graph.nodes)
    if len(document.chunks) < MIN_USEFUL_CHUNKS and not has_records:
        logger.warning(
            "browser_service.explore.timeout",
            extra={
                "requestId": invocation.correlation.requestId,
                "stage": "no_usable_observation",
                "chunks": len(document.chunks),
                "graphNodes": len(graph.nodes),
                "graphCollections": len(graph.collections),
                "elapsedSeconds": round(time.monotonic() - total_start, 2),
            },
        )
        raise ToolExecutionError("TIMEOUT", "Website exploration timed out.", retryable=True)

    warnings = _observation_warnings(settle.status, captured, list(graph.warnings))
    truncations = list(graph.truncations) + _capture_truncations(captured, boxes, rendered)

    # The contract's own bounds, applied where the payload is assembled --
    # see CONTRACT_LIMITS. `nodes` is already bounded by the graph builder's
    # MAX_GRAPH_NODES, which is that same limit.
    relationships = _clip(
        list(graph.relationships), CONTRACT_LIMITS["relationships"], "relationships", truncations
    )
    regions = _clip(list(graph.regions), CONTRACT_LIMITS["regions"], "nodes", truncations)
    collections = _clip(
        list(graph.collections), CONTRACT_LIMITS["collections"], "collections", truncations
    )
    capabilities = _clip(list(capabilities), CONTRACT_LIMITS["capabilities"], "", truncations)
    source_candidates = _clip(
        list(graph.source_candidates), CONTRACT_LIMITS["sourceCandidates"], "", truncations
    )
    warnings = warnings[: CONTRACT_LIMITS["warnings"]]
    # Last, and without recording itself: every clip above may have appended
    # here, so this is the only trim that must run after all of them.
    truncations = truncations[: CONTRACT_LIMITS["truncations"]]

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
        "relationships": relationships,
        "regions": regions,
        "collections": collections,
        "capabilities": capabilities,
        "sourceCandidates": source_candidates,
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
            "accessibility": [
                accessibility_to_wire(n)
                for n in document.accessibility[: DOCUMENT_LIMITS["accessibility"]]
            ],
            "chunks": [chunk_to_wire(c) for c in document.chunks[: DOCUMENT_LIMITS["chunks"]]],
            "warnings": [
                warning_to_wire(w) for w in document.warnings[: DOCUMENT_LIMITS["warnings"]]
            ],
            "truncations": [
                truncation_to_wire(t)
                for t in document.truncations[: DOCUMENT_LIMITS["truncations"]]
            ],
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
