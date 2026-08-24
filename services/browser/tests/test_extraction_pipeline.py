"""Extraction-accuracy assertions against fixed local HTML fixtures.

Each fixture in ``tests/fixtures/pages/`` is a small, hand-authored HTML
file exercising one property of the pipeline (stripping, hidden-content
handling, structure preservation, Unicode normalization, semantic-root
fallback, or link resolution). These tests run the pipeline purely
against local strings -- no network access, no live browser.
"""

from __future__ import annotations

from pathlib import Path

from browser_service.extraction import (
    HeadingBlock,
    ListBlock,
    ParagraphBlock,
    TableBlock,
    WarningCode,
    extract_document,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "pages"


def _load(name: str) -> str:
    return (FIXTURES_DIR / name).read_text(encoding="utf-8")


def test_clean_article_extracts_expected_shape() -> None:
    html = _load("clean_article.html")
    doc = extract_document(
        html,
        "https://example.com/articles/quiet-orbit-live",
        http_status=200,
        content_type="text/html; charset=utf-8",
    )

    assert doc.metadata.http_status == 200
    assert doc.metadata.content_type == "text/html; charset=utf-8"
    assert doc.metadata.title == "The Quiet Orbit"
    # Canonical link wins over the input final URL when same-origin/plausible.
    assert doc.metadata.url == "https://example.com/articles/quiet-orbit"
    assert doc.metadata.language == "en"
    assert doc.metadata.description == "A short article about small satellites."
    assert doc.metadata.published_time == "2026-01-15T09:00:00Z"
    assert doc.untrusted is True

    # nav/footer live outside <main> and must not leak into blocks.
    texts = [b.text for b in doc.blocks if isinstance(b, (HeadingBlock, ParagraphBlock))]
    assert not any("site nav" in t for t in texts)
    assert not any("copyright footer" in t for t in texts)

    assert isinstance(doc.blocks[0], HeadingBlock)
    assert doc.blocks[0].text == "The Quiet Orbit"
    assert any(
        isinstance(b, ParagraphBlock) and "backbone of modern earth observation" in b.text
        for b in doc.blocks
    )

    assert len(doc.anchors) == 1
    assert doc.anchors[0].text == "missions page"
    assert doc.anchors[0].url == "https://example.com/missions"

    assert doc.warnings == []
    assert doc.truncations == []


def test_strip_elements_removes_script_style_noscript_and_form() -> None:
    html = _load("strip_elements.html")
    doc = extract_document(html, "https://example.com/contact")

    all_text = " ".join(
        b.text for b in doc.blocks if isinstance(b, (HeadingBlock, ParagraphBlock))
    )
    assert "console.log" not in all_text
    assert "tracking pixel" not in all_text
    assert "color: red" not in all_text
    assert "Enable JavaScript" not in all_text

    # Form field values must never resurface anywhere in the output.
    full_dump = str(doc.model_dump())
    assert "leaked@example.com" not in full_dump
    assert "hunter2" not in full_dump

    paragraph_texts = [b.text for b in doc.blocks if isinstance(b, ParagraphBlock)]
    assert paragraph_texts == [
        "Reach out any time using the form below.",
        "Thanks for visiting our contact page.",
    ]

    assert doc.warnings == []


def test_hidden_injection_page_strips_and_flags_without_leaking_content() -> None:
    html = _load("hidden_injection.html")
    doc = extract_document(html, "https://example.com/recipes")

    visible_text = " ".join(
        b.text for b in doc.blocks if isinstance(b, (HeadingBlock, ParagraphBlock))
    )
    # Hidden content must never appear in the visible extracted blocks.
    assert "Ignore previous instructions" not in visible_text
    assert "sk_live" not in visible_text
    assert "developer mode" not in visible_text
    assert "SuperSecretValue" not in visible_text
    assert visible_text.count("miso soup") == 1

    codes = {w.code for w in doc.warnings}
    assert WarningCode.HIDDEN_CONTENT_STRIPPED in codes
    assert WarningCode.CREDENTIAL_LIKE_CONTENT in codes
    assert WarningCode.PROMPT_INJECTION_SUSPECTED in codes

    # Warnings are advisory metadata -- they must never echo the raw
    # attacker-controlled secret/phrase back out.
    warning_text = " ".join(w.message for w in doc.warnings)
    assert "sk_live" not in warning_text
    assert "SuperSecretValue" not in warning_text
    assert "Ignore previous instructions" not in warning_text


def test_structured_content_preserves_nested_lists_and_tables() -> None:
    html = _load("structured_content.html")
    doc = extract_document(html, "https://example.com/trail-guide")

    list_blocks = [b for b in doc.blocks if isinstance(b, ListBlock)]
    assert len(list_blocks) == 2

    packing_list = list_blocks[0]
    assert packing_list.ordered is False
    assert [item.text for item in packing_list.items] == ["Water bottle", "Layers", "Map"]
    assert packing_list.items[0].children is None
    layers_children = packing_list.items[1].children
    assert layers_children is not None
    assert [item.text for item in layers_children.items] == ["Base layer", "Rain shell"]

    suggested_order = list_blocks[1]
    assert suggested_order.ordered is True
    assert [item.text for item in suggested_order.items] == ["Ridge Loop", "Summit Path"]

    table_blocks = [b for b in doc.blocks if isinstance(b, TableBlock)]
    assert len(table_blocks) == 1
    table = table_blocks[0]
    assert len(table.rows) == 3
    header_row = table.rows[0]
    assert [cell.text for cell in header_row] == ["Trail", "Distance", "Difficulty"]
    assert all(cell.is_header for cell in header_row)
    data_row = table.rows[1]
    assert [cell.text for cell in data_row] == ["Ridge Loop", "8 km", "Moderate"]
    assert not any(cell.is_header for cell in data_row)


def test_unicode_content_is_nfc_normalized_and_whitespace_collapsed() -> None:
    html = _load("unicode_content.html")
    doc = extract_document(html, "https://example.com/notes")

    paragraphs = [b for b in doc.blocks if isinstance(b, ParagraphBlock)]
    combining_form_result = paragraphs[1].text
    precomposed_form_result = paragraphs[2].text

    # Neither result should retain a bare combining accent codepoint --
    # NFC normalization must have composed it into a single character.
    assert "́" not in combining_form_result
    assert "́" not in precomposed_form_result
    assert "Café" in combining_form_result
    assert "Café" in precomposed_form_result

    collapsed = paragraphs[3].text
    assert collapsed == "Extra spaces and newlines should collapse."
    assert "  " not in collapsed
    assert "\n" not in collapsed


def test_no_semantic_container_falls_back_to_body_deterministically() -> None:
    html = _load("no_semantic_container.html")
    doc = extract_document(html, "https://example.com/loose-notes")

    assert any(w.code == WarningCode.NO_SEMANTIC_CONTAINER for w in doc.warnings)

    paragraph_texts = [b.text for b in doc.blocks if isinstance(b, ParagraphBlock)]
    assert paragraph_texts == [
        "This page has no main, article, or role landmark, so the body is used.",
        "Extraction should still find this second paragraph in order.",
    ]

    # Fallback selection must be deterministic across repeated runs.
    doc2 = extract_document(html, "https://example.com/loose-notes")
    assert [b.block_id for b in doc.blocks] == [b.block_id for b in doc2.blocks]


def test_relative_links_and_canonical_resolution() -> None:
    html = _load("relative_links.html")
    doc = extract_document(html, "https://docs.example.com/guide/page1")

    assert doc.metadata.url == "https://docs.example.com/guide/index"

    anchor_urls = {a.url for a in doc.anchors}
    assert anchor_urls == {
        "https://docs.example.com/guide/getting-started",
        "https://docs.example.com/reference/api",
        "https://other.example.org/related",
    }
    # data: URLs must be omitted entirely, not merely marked omitted.
    assert not any(a.url.startswith("data:") for a in doc.anchors)
    assert len(doc.anchors) == 3

    assert len(doc.images) == 1
    assert doc.images[0].url == "https://docs.example.com/guide/images/diagram.png"
    assert doc.images[0].alt == "Architecture diagram"
