"""Payload/token-bound tests: chunk counts and sizes respect configured limits.

Uses the oversized fixture (400 repeated paragraphs) with intentionally
small limits so every limit type is exercised deterministically, without
depending on the fixture's exact byte size matching the library defaults.
"""

from __future__ import annotations

from pathlib import Path

from browser_service.extraction import ExtractionLimits, WarningCode, extract_document

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "pages"


def _load(name: str) -> str:
    return (FIXTURES_DIR / name).read_text(encoding="utf-8")


def test_oversized_page_is_truncated_with_explicit_warnings() -> None:
    html = _load("oversized.html")
    limits = ExtractionLimits(max_total_chars=3000, max_chunk_chars=300, max_chunks=3)

    doc = extract_document(html, "https://example.com/oversized", limits=limits)

    # Chunk size bound is respected everywhere.
    assert all(len(chunk.text) <= limits.max_chunk_chars for chunk in doc.chunks)
    # Chunk count bound is respected.
    assert len(doc.chunks) <= limits.max_chunks

    codes = {w.code for w in doc.warnings}
    assert WarningCode.DOCUMENT_TRUNCATED in codes
    assert WarningCode.CHUNK_LIMIT_REACHED in codes

    reasons = {t.reason for t in doc.truncations}
    assert "max_total_chars limit reached" in reasons
    assert "max_chunks limit reached" in reasons

    # Truncation details reference where the cut happened -- never silent.
    for truncation in doc.truncations:
        assert truncation.removed_chars > 0 or truncation.removed_block_count > 0


def test_default_limits_leave_a_small_page_untouched() -> None:
    html = _load("clean_article.html")
    doc = extract_document(html, "https://example.com/articles/quiet-orbit")

    assert doc.truncations == []
    assert not any(
        w.code in (WarningCode.DOCUMENT_TRUNCATED, WarningCode.CHUNK_LIMIT_REACHED)
        for w in doc.warnings
    )


def test_chunk_ids_are_sequential_and_stable_across_runs() -> None:
    html = _load("structured_content.html")
    limits = ExtractionLimits(max_total_chars=10_000, max_chunk_chars=80, max_chunks=100)

    doc1 = extract_document(html, "https://example.com/trail-guide", limits=limits)
    doc2 = extract_document(html, "https://example.com/trail-guide", limits=limits)

    ids1 = [c.chunk_id for c in doc1.chunks]
    ids2 = [c.chunk_id for c in doc2.chunks]
    assert ids1 == ids2
    assert ids1 == [f"chunk-{i}" for i in range(len(ids1))]

    offsets1 = [(c.start_offset, c.end_offset) for c in doc1.chunks]
    offsets2 = [(c.start_offset, c.end_offset) for c in doc2.chunks]
    assert offsets1 == offsets2


def test_chunks_never_have_negative_or_inverted_offsets() -> None:
    html = _load("oversized.html")
    limits = ExtractionLimits(max_total_chars=5000, max_chunk_chars=150, max_chunks=50)
    doc = extract_document(html, "https://example.com/oversized", limits=limits)

    for chunk in doc.chunks:
        assert chunk.start_offset >= 0
        assert chunk.end_offset >= chunk.start_offset
        assert chunk.end_offset - chunk.start_offset == len(chunk.text)
