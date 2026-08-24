"""The `browser.navigate_and_extract` tool (P02-F04): composes the
read-only browser-automation primitives (P02-F01,
`browser_service.browser`) and the content-extraction pipeline (P02-F02,
`browser_service.extraction`) into one bounded operation.

This module owns the ONE shared :class:`BrowserLifecycleManager` for the
whole service process; callers (the tool registry) never construct or
reach into browser/navigation/extraction primitives directly -- they stay
private to this module, per the phase's "keep lower-level browser
primitives private" requirement. Nothing here exposes click, form,
script-evaluation, or mutation capability: navigation is a single
NAVIGATE + GET_CONTENT pair, exactly as `browser_service.browser`
exposes.
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
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
)
from browser_service.contracts import InvocationNavigateAndExtract
from browser_service.extraction import (
    Chunk,
    DocumentMetadata,
    ExtractedDocument,
    ExtractionWarning,
    TruncationDetail,
    extract_document,
)
from browser_service.tool_outcome import ToolExecutionError, ToolHandlerOutcome

MAX_EVIDENCE_ITEMS = 20
EVIDENCE_SNIPPET_MAX_LENGTH = 2_000

_lifecycle_manager: BrowserLifecycleManager | None = None
_lifecycle_manager_lock = asyncio.Lock()


async def _get_lifecycle_manager() -> BrowserLifecycleManager:
    """Lazily creates the one process-wide browser lifecycle manager.

    Lazy (not created at import time) so importing this module -- e.g. to
    register the tool -- never itself launches Chrome; the first real
    invocation pays that cost.
    """
    global _lifecycle_manager
    async with _lifecycle_manager_lock:
        if _lifecycle_manager is None:
            _lifecycle_manager = BrowserLifecycleManager()
        return _lifecycle_manager


def _normalize_published_time(raw: str | None) -> str | None:
    """Best-effort parse of a page-supplied timestamp into a strict,
    offset-aware ISO-8601 string, or ``None`` if it doesn't parse.

    Page content is untrusted: `DocumentMetadata.published_time` is
    whatever string the page's own structured metadata contained (see
    `browser_service.extraction`'s docstrings), which is not guaranteed
    to already be well-formed. Never let a malformed date from the page
    fail the whole tool result -- drop it instead.
    """
    if raw is None:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.isoformat()


def _metadata_to_wire(
    metadata: DocumentMetadata, http_status: int | None, content_type: str | None
) -> dict[str, Any]:
    return {
        "title": metadata.title,
        "url": metadata.url,
        "language": metadata.language,
        "description": metadata.description,
        "publishedTime": _normalize_published_time(metadata.published_time),
        "httpStatus": http_status,
        "contentType": content_type,
    }


def _chunk_to_wire(chunk: Chunk) -> dict[str, Any]:
    return {
        "chunkId": chunk.chunk_id,
        "text": chunk.text,
        "startOffset": chunk.start_offset,
        "endOffset": chunk.end_offset,
    }


def _warning_to_wire(warning: ExtractionWarning) -> dict[str, Any]:
    wire: dict[str, Any] = {"code": warning.code.value, "message": warning.message}
    if warning.block_id is not None:
        wire["blockId"] = warning.block_id
    if warning.chunk_id is not None:
        wire["chunkId"] = warning.chunk_id
    if warning.offset is not None:
        wire["offset"] = warning.offset
    return wire


def _truncation_to_wire(truncation: TruncationDetail) -> dict[str, Any]:
    wire: dict[str, Any] = {
        "reason": truncation.reason,
        "removedBlockCount": truncation.removed_block_count,
        "removedChars": truncation.removed_chars,
    }
    if truncation.at_chunk_id is not None:
        wire["atChunkId"] = truncation.at_chunk_id
    if truncation.at_offset is not None:
        wire["atOffset"] = truncation.at_offset
    return wire


def _build_evidence(doc: ExtractedDocument, final_url: str) -> list[dict[str, Any]]:
    """One bounded `EvidenceItem` per chunk (capped at 20, per
    `EvidenceListSchema`), so any tool-agnostic evidence consumer sees
    this result the same way it sees any other tool's citations.
    """
    retrieved_at = datetime.now(UTC).isoformat()
    evidence: list[dict[str, Any]] = []
    for chunk in doc.chunks[:MAX_EVIDENCE_ITEMS]:
        evidence.append(
            {
                "sourceUrl": final_url,
                "title": doc.metadata.title,
                "snippet": chunk.text[:EVIDENCE_SNIPPET_MAX_LENGTH],
                "retrievedAt": retrieved_at,
            }
        )
    return evidence


def _build_payload(
    doc: ExtractedDocument,
    *,
    navigation_ms: float,
    extraction_ms: float,
    http_status: int | None,
    content_type: str | None,
) -> dict[str, Any]:
    return {
        "metadata": _metadata_to_wire(doc.metadata, http_status, content_type),
        "chunks": [_chunk_to_wire(chunk) for chunk in doc.chunks],
        "warnings": [_warning_to_wire(warning) for warning in doc.warnings],
        "truncations": [_truncation_to_wire(truncation) for truncation in doc.truncations],
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
    manager = manager if manager is not None else await _get_lifecycle_manager()
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

    extraction_start = time.monotonic()
    document = extract_document(content_result.content or "", navigate_result.final_url)
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
    evidence = _build_evidence(document, navigate_result.final_url)
    return ToolHandlerOutcome(payload=payload, evidence=evidence)


__all__ = ["run_navigate_and_extract"]
