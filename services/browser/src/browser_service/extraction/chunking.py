"""Split extracted content blocks into stable, bounded, document-local chunks.

Chunks are built by walking blocks in document order and packing them
(greedily, respecting ``max_chunk_chars``) without ever splitting across a
block boundary except when a single block's own flattened text exceeds
``max_chunk_chars`` -- in that case the block's text is divided at the
best available sentence boundary (falling back to a whitespace boundary,
and only as a last resort a hard character cut) so multiple chunks can
still reference the same block. No content is lost by this splitting; it
only affects how blocks are grouped into chunks.

Two configured limits *do* cause real, reported data loss when exceeded:
``max_total_chars`` (whole trailing blocks are dropped) and
``max_chunks`` (trailing chunks are dropped). Both always produce an
explicit :class:`~browser_service.extraction.models.TruncationDetail` and
:class:`~browser_service.extraction.models.ExtractionWarning` -- content is
never silently cut.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from browser_service.extraction.content_blocks import block_flat_text
from browser_service.extraction.models import (
    Chunk,
    ContentBlock,
    ExtractionLimits,
    ExtractionWarning,
    TruncationDetail,
    WarningCode,
)

_SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+")


@dataclass(frozen=True)
class ChunkingResult:
    chunks: list[Chunk]
    canonical_text: str
    truncations: list[TruncationDetail]
    warnings: list[ExtractionWarning]


def _accumulate_within_budget(
    items: list[tuple[ContentBlock, str]], max_total_chars: int
) -> tuple[list[tuple[ContentBlock, str]], int]:
    kept: list[tuple[ContentBlock, str]] = []
    parts: list[str] = []
    length = 0
    for block, text in items:
        separator_len = 2 if parts else 0
        new_length = length + separator_len + len(text)
        if kept and new_length > max_total_chars:
            break
        kept.append((block, text))
        parts.append(text)
        length = new_length
    return kept, length


def _compute_spans(
    kept: list[tuple[ContentBlock, str]],
) -> list[tuple[str, str, int, int]]:
    spans: list[tuple[str, str, int, int]] = []
    cursor = 0
    for index, (block, text) in enumerate(kept):
        if index > 0:
            cursor += 2  # "\n\n" separator between blocks in canonical text
        start = cursor
        end = start + len(text)
        spans.append((block.block_id, text, start, end))
        cursor = end
    return spans


def _split_text_into_pieces(text: str, max_len: int) -> list[tuple[int, int]]:
    """Split ``text`` into <= ``max_len`` pieces, preferring sentence boundaries."""
    n = len(text)
    if n <= max_len:
        return [(0, n)]

    pieces: list[tuple[int, int]] = []
    pos = 0
    while pos < n:
        remaining = n - pos
        if remaining <= max_len:
            pieces.append((pos, n))
            break
        window = text[pos : pos + max_len]
        boundary: int | None = None
        for match in _SENTENCE_BOUNDARY_RE.finditer(window):
            boundary = match.start()
        if not boundary:
            ws_index = window.rfind(" ")
            boundary = ws_index if ws_index > 0 else max_len
        pieces.append((pos, pos + boundary))
        pos += boundary
        while pos < n and text[pos].isspace():
            pos += 1
    return pieces


def _build_chunks(
    spans: list[tuple[str, str, int, int]], max_chunk_chars: int
) -> list[Chunk]:
    chunks: list[Chunk] = []
    chunk_index = 0
    pending_ids: list[str] = []
    pending_parts: list[str] = []
    pending_start: int | None = None
    pending_end = 0

    def flush() -> None:
        nonlocal chunk_index, pending_ids, pending_parts, pending_start, pending_end
        if pending_ids:
            chunks.append(
                Chunk(
                    chunk_id=f"chunk-{chunk_index}",
                    start_offset=pending_start or 0,
                    end_offset=pending_end,
                    text="\n\n".join(pending_parts),
                    block_ids=list(dict.fromkeys(pending_ids)),
                )
            )
            chunk_index += 1
        pending_ids = []
        pending_parts = []
        pending_start = None

    for block_id, text, start, end in spans:
        if len(text) > max_chunk_chars:
            flush()
            for local_start, local_end in _split_text_into_pieces(text, max_chunk_chars):
                chunks.append(
                    Chunk(
                        chunk_id=f"chunk-{chunk_index}",
                        start_offset=start + local_start,
                        end_offset=start + local_end,
                        text=text[local_start:local_end],
                        block_ids=[block_id],
                    )
                )
                chunk_index += 1
            continue

        candidate_len = end - (pending_start if pending_start is not None else start)
        if pending_ids and candidate_len > max_chunk_chars:
            flush()
        if pending_start is None:
            pending_start = start
        pending_ids.append(block_id)
        pending_parts.append(text)
        pending_end = end

    flush()
    return chunks


def build_chunks(blocks: list[ContentBlock], limits: ExtractionLimits) -> ChunkingResult:
    items = [(block, block_flat_text(block)) for block in blocks]
    items = [(block, text) for block, text in items if text]

    full_canonical_text = "\n\n".join(text for _, text in items)
    kept, kept_length = _accumulate_within_budget(items, limits.max_total_chars)

    warnings: list[ExtractionWarning] = []
    truncations: list[TruncationDetail] = []

    removed_block_count = len(items) - len(kept)
    if removed_block_count > 0 or kept_length > limits.max_total_chars:
        removed_chars = len(full_canonical_text) - kept_length
        truncations.append(
            TruncationDetail(
                reason="max_total_chars limit reached",
                at_offset=kept_length,
                removed_block_count=removed_block_count,
                removed_chars=max(removed_chars, 0),
            )
        )
        warnings.append(
            ExtractionWarning(
                code=WarningCode.DOCUMENT_TRUNCATED,
                message=(
                    f"Document exceeded the configured max_total_chars limit "
                    f"({limits.max_total_chars}); trailing content was dropped."
                ),
                offset=kept_length,
            )
        )

    spans = _compute_spans(kept)
    canonical_text = "\n\n".join(text for _, text in kept)
    all_chunks = _build_chunks(spans, limits.max_chunk_chars)

    if len(all_chunks) > limits.max_chunks:
        kept_chunks = all_chunks[: limits.max_chunks]
        dropped_chunks = all_chunks[limits.max_chunks :]
        removed_chars = sum(len(c.text) for c in dropped_chunks)
        dropped_block_ids = {block_id for c in dropped_chunks for block_id in c.block_ids}
        last_chunk_id = kept_chunks[-1].chunk_id if kept_chunks else None
        last_offset = kept_chunks[-1].end_offset if kept_chunks else 0
        truncations.append(
            TruncationDetail(
                reason="max_chunks limit reached",
                at_chunk_id=last_chunk_id,
                at_offset=last_offset,
                removed_block_count=len(dropped_block_ids),
                removed_chars=removed_chars,
            )
        )
        warnings.append(
            ExtractionWarning(
                code=WarningCode.CHUNK_LIMIT_REACHED,
                message=(
                    f"Stopped after the configured max_chunks limit "
                    f"({limits.max_chunks}); remaining chunks were dropped."
                ),
                chunk_id=last_chunk_id,
                offset=last_offset,
            )
        )
        all_chunks = kept_chunks

    return ChunkingResult(
        chunks=all_chunks,
        canonical_text=canonical_text,
        truncations=truncations,
        warnings=warnings,
    )
