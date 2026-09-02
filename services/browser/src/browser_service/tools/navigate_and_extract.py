"""The `browser.navigate_and_extract` tool (P02-F04): composes the
read-only browser-automation primitives (P02-F01,
`browser_service.browser`) and the content-extraction pipeline (P02-F02,
`browser_service.extraction`) into one bounded operation.

Callers (the tool registry) never construct or reach into
browser/navigation/extraction primitives directly -- they stay private to
this module, per the phase's "keep lower-level browser primitives
private" requirement. Nothing here exposes click, form,
script-evaluation, or mutation capability: navigation is a single
NAVIGATE + GET_CONTENT pair, exactly as `browser_service.browser`
exposes. The one process-wide :class:`BrowserLifecycleManager` every
browser-driving tool shares lives in `_lifecycle.py`, not here.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

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
    capture_accessibility,
)
from browser_service.contracts import InvocationNavigateAndExtract
from browser_service.extraction import ExtractedDocument, extract_document
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


def _build_payload(
    doc: ExtractedDocument,
    *,
    navigation_ms: float,
    extraction_ms: float,
    http_status: int | None,
    content_type: str | None,
) -> dict[str, Any]:
    return {
        "metadata": metadata_to_wire(doc.metadata, http_status, content_type),
        "accessibility": [accessibility_to_wire(node) for node in doc.accessibility],
        "chunks": [chunk_to_wire(chunk) for chunk in doc.chunks],
        "warnings": [warning_to_wire(warning) for warning in doc.warnings],
        "truncations": [truncation_to_wire(truncation) for truncation in doc.truncations],
        "timing": {
            "navigationMs": navigation_ms,
            "extractionMs": extraction_ms,
            "totalMs": navigation_ms + extraction_ms,
        },
        "untrusted": True,
    }


async def run_navigate_and_extract(
    invocation: InvocationNavigateAndExtract,
    cancelled: asyncio.Event,
    *,
    policy: UrlPolicy | None = None,
    manager: BrowserLifecycleManager | None = None,
) -> ToolHandlerOutcome:
    """Navigates to `invocation.arguments.url`, extracts bounded content,
    and returns the tool's success payload + evidence.

    `policy`/`manager` are only ever supplied by this project's own tests
    (see `tests/test_navigate_and_extract.py`) to point navigation at the
    local fixture server / a disposable browser instead of the shared
    production singleton -- `tool_registry.TOOL_REGISTRY` calls this with
    exactly `(invocation, cancelled)`, so production always gets the
    strict default `UrlPolicy()` (no host allowlisted) and the one
    shared, lazily-created `BrowserLifecycleManager`.

    Raises :class:`ToolExecutionError` (never a raw internal exception)
    for every expected failure mode: a policy-blocked URL, a timeout, a
    cancellation, or an upstream navigation failure -- see the inline
    mapping below for exactly which `ToolErrorCode` each maps to.
    """
    url = invocation.arguments.url
    manager = manager if manager is not None else await get_lifecycle_manager()
    navigation_service = NavigationService(policy if policy is not None else UrlPolicy())

    total_start = time.monotonic()
    async with manager.isolated_context() as context:
        page = await context.open_page()

        nav_start = time.monotonic()
        try:
            navigate_result = await navigation_service.navigate(page, url, cancelled=cancelled)
        except NavigationBlockedError as exc:
            raise ToolExecutionError(
                "INVALID_ARGUMENTS",
                f"The URL was blocked by navigation policy ({exc.reason}).",
                retryable=False,
            ) from exc
        except NavigationCancelledError as exc:
            raise ToolExecutionError(
                "CANCELLED", "Navigation was cancelled.", retryable=True
            ) from exc
        except NavigationTimeoutError as exc:
            raise ToolExecutionError(
                "TIMEOUT", f"Navigation timed out ({exc.phase}).", retryable=True
            ) from exc
        except (TooManyRedirectsError, ResponseTooLargeError) as exc:
            raise ToolExecutionError(
                "UPSTREAM_UNAVAILABLE", "The page could not be safely retrieved.", retryable=False
            ) from exc
        except NavigationError as exc:
            raise ToolExecutionError(
                "UPSTREAM_UNAVAILABLE", "The page could not be retrieved.", retryable=True
            ) from exc
        navigation_ms = (time.monotonic() - nav_start) * 1000

        try:
            # The capture must describe the *settled* render, so the
            # accessibility tree and the serialized DOM are both taken after
            # the page reaches its bounded quiet state -- not mid-hydration,
            # where a client-rendered page still reports an empty document.
            session = await context.open_cdp_session(page)
            await wait_for_settle(session)
            content_result = await navigation_service.get_content(page, cancelled=cancelled)
        except NavigationCancelledError as exc:
            raise ToolExecutionError(
                "CANCELLED", "Navigation was cancelled.", retryable=True
            ) from exc
        except NavigationTimeoutError as exc:
            raise ToolExecutionError(
                "TIMEOUT", f"Reading page content timed out ({exc.phase}).", retryable=True
            ) from exc
        except NavigationError as exc:
            raise ToolExecutionError(
                "UPSTREAM_UNAVAILABLE", "The page's content could not be read.", retryable=True
            ) from exc

        accessibility = await capture_accessibility(session)

    extraction_start = time.monotonic()
    document = extract_document(
        content_result.content or "",
        navigate_result.final_url,
        accessibility_nodes=accessibility.ax_nodes,
        accessibility_available=accessibility.available,
        dom_tag_by_backend_id=accessibility.dom_tag_by_backend_id,
    )
    extraction_ms = (time.monotonic() - extraction_start) * 1000
    total_ms = (time.monotonic() - total_start) * 1000

    payload = _build_payload(
        document,
        navigation_ms=navigation_ms,
        extraction_ms=extraction_ms,
        http_status=None,
        content_type=None,
    )
    payload["timing"]["totalMs"] = total_ms
    evidence = build_evidence(document, navigate_result.final_url)
    return ToolHandlerOutcome(payload=payload, evidence=evidence)


__all__ = ["run_navigate_and_extract"]
