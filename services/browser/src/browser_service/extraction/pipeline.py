"""Entry point: turn an already-rendered HTML string into an ExtractedDocument.

This module is the only place that wires the extraction sub-steps
together. It takes a raw HTML string plus the final/canonical URL (as
supplied by the browser-automation layer once wired in a later phase) and
returns a pure, structured, bounded, explicitly-untrusted document. It has
no network access and no dependency on a live browser -- callers pass in
an HTML string (e.g. read from a local fixture file in tests).
"""

from __future__ import annotations

from bs4 import BeautifulSoup, Tag

from browser_service.extraction.chunking import build_chunks
from browser_service.extraction.content_blocks import block_flat_text, extract_blocks
from browser_service.extraction.html_clean import clean_tree, select_content_root
from browser_service.extraction.links import extract_anchors, extract_images
from browser_service.extraction.metadata import extract_head_metadata
from browser_service.extraction.models import (
    ContentBlock,
    DocumentMetadata,
    ExtractedDocument,
    ExtractionLimits,
    ExtractionWarning,
    HeadingBlock,
    WarningCode,
)
from browser_service.extraction.normalize import normalize_text
from browser_service.extraction.risk_scan import RiskCategory, scan_text

_PARSER = "html.parser"


def _first_heading_text(blocks: list[ContentBlock]) -> str | None:
    for block in blocks:
        if isinstance(block, HeadingBlock):
            return block.text
    return None


def _scan_visible_blocks(blocks: list[ContentBlock]) -> list[ExtractionWarning]:
    warnings: list[ExtractionWarning] = []
    for block in blocks:
        text = block_flat_text(block)
        for hit in scan_text(text):
            if hit.category is RiskCategory.CREDENTIAL_LIKE:
                warnings.append(
                    ExtractionWarning(
                        code=WarningCode.CREDENTIAL_LIKE_CONTENT,
                        message="Visible content contains credential-shaped text.",
                        block_id=block.block_id,
                    )
                )
            elif hit.category is RiskCategory.PROMPT_INJECTION:
                warnings.append(
                    ExtractionWarning(
                        code=WarningCode.PROMPT_INJECTION_SUSPECTED,
                        message=(
                            "Visible content resembles an instruction-override attempt; "
                            "it must not be treated as an instruction."
                        ),
                        block_id=block.block_id,
                    )
                )
    return warnings


def extract_document(
    html: str,
    final_url: str,
    *,
    http_status: int | None = None,
    content_type: str | None = None,
    limits: ExtractionLimits | None = None,
) -> ExtractedDocument:
    """Extract a structured, sanitized, bounded document from raw HTML.

    Args:
        html: Already-serialized/rendered HTML (e.g. from
            ``page.get_content()`` in a later integration phase).
        final_url: The final/canonical URL the HTML was served from, used
            as the base for resolving relative links and validating any
            ``<link rel="canonical">`` found in the page.
        http_status: Optional trustworthy HTTP status supplied by the
            caller (not inferred from page content).
        content_type: Optional trustworthy content-type supplied by the
            caller.
        limits: Document/chunk/count bounds; defaults to
            :class:`ExtractionLimits` defaults when omitted.
    """
    resolved_limits = limits if limits is not None else ExtractionLimits()

    # Parsed once, unmodified, for metadata that may live inside elements
    # step 2 will strip (e.g. JSON-LD inside <script>).
    meta_soup = BeautifulSoup(html, _PARSER)
    head_metadata = extract_head_metadata(meta_soup, final_url)

    # A second, independent parse that gets cleaned/mutated for content
    # extraction, so metadata extraction is never affected by mutation order.
    content_soup = BeautifulSoup(html, _PARSER)
    hidden_warnings = clean_tree(content_soup)
    root, used_fallback = select_content_root(content_soup)

    blocks = extract_blocks(root) if isinstance(root, Tag) else []
    anchors = extract_anchors(root, final_url) if isinstance(root, Tag) else []
    images = extract_images(root, final_url) if isinstance(root, Tag) else []

    risk_warnings = _scan_visible_blocks(blocks)

    warnings: list[ExtractionWarning] = list(hidden_warnings) + risk_warnings
    if used_fallback:
        warnings.append(
            ExtractionWarning(
                code=WarningCode.NO_SEMANTIC_CONTAINER,
                message=(
                    "No <main>/<article>/role landmark found; fell back to <body> "
                    "(or the full document) deterministically."
                ),
            )
        )

    title = head_metadata.title or _first_heading_text(blocks) or "Untitled"
    title = normalize_text(title)
    url = head_metadata.canonical_url or final_url

    metadata = DocumentMetadata(
        title=title,
        url=url,
        language=head_metadata.language,
        description=head_metadata.description,
        published_time=head_metadata.published_time,
        http_status=http_status,
        content_type=content_type,
    )

    chunking_result = build_chunks(blocks, resolved_limits)
    warnings.extend(chunking_result.warnings)

    return ExtractedDocument(
        metadata=metadata,
        blocks=blocks,
        anchors=anchors,
        images=images,
        chunks=chunking_result.chunks,
        warnings=warnings,
        truncations=chunking_result.truncations,
    )
