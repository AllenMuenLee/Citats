"""Wire-shaping for the `document` sub-shape `browser.navigate_and_extract`
(P02-F04) returns: `metadata`/`chunks`/`warnings`/`truncations`/`timing`/
evidence. Private to `browser_service.tools`; not part of the public tool
surface.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from browser_service.extraction import (
    AccessibilityNode,
    Chunk,
    DocumentMetadata,
    ExtractedDocument,
    ExtractionWarning,
    TruncationDetail,
)

MAX_EVIDENCE_ITEMS = 20
EVIDENCE_SNIPPET_MAX_LENGTH = 2_000


def normalize_published_time(raw: str | None) -> str | None:
    """Best-effort parse of a page-supplied timestamp into a strict,
    offset-aware ISO-8601 string, or ``None`` if it doesn't parse.

    Page content is untrusted: `DocumentMetadata.published_time` is
    whatever string the page's own structured metadata contained, which is
    not guaranteed to already be well-formed. Never let a malformed date
    from the page fail the whole tool result -- drop it instead.
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


def metadata_to_wire(
    metadata: DocumentMetadata, http_status: int | None, content_type: str | None
) -> dict[str, Any]:
    return {
        "title": metadata.title,
        "url": metadata.url,
        "origin": metadata.origin,
        "language": metadata.language,
        "description": metadata.description,
        "author": metadata.author,
        "publishedTime": normalize_published_time(metadata.published_time),
        "updatedTime": normalize_published_time(metadata.updated_time),
        "siteName": metadata.site_name,
        "pageType": metadata.page_type,
        "imageUrl": metadata.image_url,
        "httpStatus": http_status,
        "contentType": content_type,
    }


def accessibility_to_wire(node: AccessibilityNode) -> dict[str, Any]:
    return {
        "nodeId": node.node_id,
        "parentId": node.parent_id,
        "role": node.role,
        "name": node.name,
        "description": node.description,
        "value": node.value,
        "states": node.states,
        "domTag": node.dom_tag,
        "correlated": node.correlated,
    }


def chunk_to_wire(chunk: Chunk) -> dict[str, Any]:
    return {
        "chunkId": chunk.chunk_id,
        "text": chunk.text,
        "startOffset": chunk.start_offset,
        "endOffset": chunk.end_offset,
    }


def warning_to_wire(warning: ExtractionWarning) -> dict[str, Any]:
    wire: dict[str, Any] = {"code": warning.code.value, "message": warning.message}
    if warning.block_id is not None:
        wire["blockId"] = warning.block_id
    if warning.chunk_id is not None:
        wire["chunkId"] = warning.chunk_id
    if warning.offset is not None:
        wire["offset"] = warning.offset
    return wire


def truncation_to_wire(truncation: TruncationDetail) -> dict[str, Any]:
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



def build_evidence(doc: ExtractedDocument, final_url: str) -> list[dict[str, Any]]:
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


__all__ = [
    "accessibility_to_wire",
    "build_evidence",
    "chunk_to_wire",
    "metadata_to_wire",
    "normalize_published_time",
    "truncation_to_wire",
    "warning_to_wire",
]
