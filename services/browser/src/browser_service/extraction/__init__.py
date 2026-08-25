"""Pure, testable content-extraction pipeline (Phase 2, P02-F02).

Public API:

- :func:`browser_service.extraction.pipeline.extract_document` -- the
  single entry point. Takes an already-rendered HTML string plus the
  final/canonical URL and returns an :class:`ExtractedDocument`.
- The Pydantic models in :mod:`browser_service.extraction.models`
  describing that document's shape.

This package has no dependency on a live browser, Nodriver, or the
network -- it operates purely on HTML strings (e.g. local fixtures in
tests, or ``page.get_content()`` output once wired in by a later
integration phase). All extracted content is untrusted page data, never
instructions.
"""

from __future__ import annotations

from browser_service.extraction.models import (
    Affordance,
    AffordanceRole,
    Anchor,
    Chunk,
    ContentBlock,
    DocumentMetadata,
    ExtractedDocument,
    ExtractionLimits,
    ExtractionWarning,
    HeadingBlock,
    ImageRef,
    ListBlock,
    ListItem,
    ParagraphBlock,
    TableBlock,
    TableCell,
    TruncationDetail,
    WarningCode,
)
from browser_service.extraction.pipeline import extract_document

__all__ = [
    "Affordance",
    "AffordanceRole",
    "Anchor",
    "Chunk",
    "ContentBlock",
    "DocumentMetadata",
    "ExtractedDocument",
    "ExtractionLimits",
    "ExtractionWarning",
    "HeadingBlock",
    "ImageRef",
    "ListBlock",
    "ListItem",
    "ParagraphBlock",
    "TableBlock",
    "TableCell",
    "TruncationDetail",
    "WarningCode",
    "extract_document",
]
