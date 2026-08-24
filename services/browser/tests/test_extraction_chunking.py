"""Unit tests for the chunking module against synthetic content blocks.

These exercise the chunk-building logic directly (bypassing HTML parsing)
so behavior at block boundaries -- including an oversized single block
that must itself be split across multiple chunks -- can be pinned down
precisely.
"""

from __future__ import annotations

from browser_service.extraction.chunking import build_chunks
from browser_service.extraction.models import (
    ExtractionLimits,
    HeadingBlock,
    ParagraphBlock,
)


def _make_blocks() -> list[HeadingBlock | ParagraphBlock]:
    return [
        HeadingBlock(block_id="block-0", level=1, text="Title"),
        ParagraphBlock(block_id="block-1", text="First short paragraph."),
        ParagraphBlock(block_id="block-2", text="Second short paragraph."),
        ParagraphBlock(block_id="block-3", text="Third short paragraph."),
    ]


def test_small_blocks_are_packed_into_a_single_chunk_within_budget() -> None:
    blocks = _make_blocks()
    limits = ExtractionLimits(max_total_chars=10_000, max_chunk_chars=10_000, max_chunks=10)

    result = build_chunks(blocks, limits)  # type: ignore[arg-type]

    assert len(result.chunks) == 1
    assert result.chunks[0].block_ids == ["block-0", "block-1", "block-2", "block-3"]
    assert result.truncations == []
    assert result.warnings == []


def test_tight_chunk_budget_splits_across_block_boundaries_only() -> None:
    blocks = _make_blocks()
    limits = ExtractionLimits(max_total_chars=10_000, max_chunk_chars=30, max_chunks=10)

    result = build_chunks(blocks, limits)  # type: ignore[arg-type]

    assert len(result.chunks) > 1
    for chunk in result.chunks:
        assert len(chunk.text) <= limits.max_chunk_chars
        # No chunk text starts or ends mid-word (a proxy for "not mid-tag").
        assert chunk.text == chunk.text.strip()


def test_oversized_single_block_is_split_without_losing_content() -> None:
    long_text = " ".join(f"Sentence number {i} in a very long paragraph." for i in range(60))
    blocks: list[HeadingBlock | ParagraphBlock] = [
        ParagraphBlock(block_id="block-0", text=long_text)
    ]
    limits = ExtractionLimits(max_total_chars=100_000, max_chunk_chars=120, max_chunks=100)

    result = build_chunks(blocks, limits)  # type: ignore[arg-type]

    assert len(result.chunks) > 1
    assert all(chunk.block_ids == ["block-0"] for chunk in result.chunks)
    assert all(len(chunk.text) <= limits.max_chunk_chars for chunk in result.chunks)

    # Chunks are contiguous/non-overlapping and in increasing order.
    starts_and_ends = [(c.start_offset, c.end_offset) for c in result.chunks]
    for (_, prev_end), (next_start, _) in zip(
        starts_and_ends, starts_and_ends[1:], strict=False
    ):
        assert next_start >= prev_end

    # No truncation occurred -- this is a split for size, not a content drop.
    assert result.truncations == []
    assert result.warnings == []


def test_max_total_chars_drops_trailing_blocks_with_explicit_truncation() -> None:
    blocks = _make_blocks()
    # Budget only large enough for the heading and first paragraph.
    limits = ExtractionLimits(max_total_chars=40, max_chunk_chars=1000, max_chunks=10)

    result = build_chunks(blocks, limits)  # type: ignore[arg-type]

    kept_block_ids = {block_id for chunk in result.chunks for block_id in chunk.block_ids}
    assert "block-3" not in kept_block_ids
    assert len(result.truncations) == 1
    assert result.truncations[0].reason == "max_total_chars limit reached"
    assert result.truncations[0].removed_block_count > 0


def test_max_chunks_drops_trailing_chunks_with_explicit_truncation() -> None:
    blocks = _make_blocks()
    limits = ExtractionLimits(max_total_chars=10_000, max_chunk_chars=10, max_chunks=1)

    result = build_chunks(blocks, limits)  # type: ignore[arg-type]

    assert len(result.chunks) == 1
    assert any(t.reason == "max_chunks limit reached" for t in result.truncations)


def test_determinism_same_input_same_output() -> None:
    blocks_a = _make_blocks()
    blocks_b = _make_blocks()
    limits = ExtractionLimits(max_total_chars=1000, max_chunk_chars=20, max_chunks=10)

    result_a = build_chunks(blocks_a, limits)  # type: ignore[arg-type]
    result_b = build_chunks(blocks_b, limits)  # type: ignore[arg-type]

    assert [c.model_dump() for c in result_a.chunks] == [c.model_dump() for c in result_b.chunks]
