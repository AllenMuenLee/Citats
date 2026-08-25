"""Pydantic models for the content extraction pipeline.

These models describe the pure, structured, bounded document produced by
``browser_service.extraction.pipeline.extract_document`` from an
already-rendered HTML string. Nothing in this module talks to a live
browser, the network, or a database -- see ``pipeline.py`` for the entry
point.

Every ``ExtractedDocument`` is explicitly marked ``untrusted`` because its
content originates from an arbitrary web page: page text and attribute
values must never be treated as instructions by anything that consumes
this output.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class WarningCode(StrEnum):
    """Machine-readable categories for :class:`ExtractionWarning`."""

    HIDDEN_CONTENT_STRIPPED = "hidden_content_stripped"
    CREDENTIAL_LIKE_CONTENT = "credential_like_content"
    PROMPT_INJECTION_SUSPECTED = "prompt_injection_suspected"
    DOCUMENT_TRUNCATED = "document_truncated"
    CHUNK_TRUNCATED = "chunk_truncated"
    CHUNK_LIMIT_REACHED = "chunk_limit_reached"
    NO_SEMANTIC_CONTAINER = "no_semantic_container"
    AFFORDANCE_LIMIT_REACHED = "affordance_limit_reached"


class ExtractionWarning(BaseModel):
    """A single advisory warning surfaced alongside the extracted document.

    Warnings never repeat the raw attacker-controlled text that triggered
    them (e.g. a matched credential or injection phrase) -- only a
    category, a human-readable note, and a document-local location.
    """

    model_config = ConfigDict(extra="forbid")

    code: WarningCode
    message: str
    block_id: str | None = None
    chunk_id: str | None = None
    offset: int | None = None


class TruncationDetail(BaseModel):
    """Records what was cut from the document and why."""

    model_config = ConfigDict(extra="forbid")

    reason: str
    at_chunk_id: str | None = None
    at_offset: int | None = None
    removed_block_count: int = 0
    removed_chars: int = 0


class DocumentMetadata(BaseModel):
    """Document-level metadata captured only from trustworthy structured sources."""

    model_config = ConfigDict(extra="forbid")

    title: str
    url: str
    language: str = "und"
    description: str | None = None
    published_time: str | None = None
    http_status: int | None = None
    content_type: str | None = None


class HeadingBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["heading"] = "heading"
    block_id: str
    level: int
    text: str


class ParagraphBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["paragraph"] = "paragraph"
    block_id: str
    text: str


class ListItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    children: ListBlock | None = None


class ListBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["list"] = "list"
    block_id: str
    ordered: bool
    items: list[ListItem]


ListItem.model_rebuild()


class TableCell(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    is_header: bool = False


class TableBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["table"] = "table"
    block_id: str
    rows: list[list[TableCell]]


ContentBlock = Annotated[
    HeadingBlock | ParagraphBlock | ListBlock | TableBlock,
    Field(discriminator="type"),
]


class Anchor(BaseModel):
    """Link text plus its resolved absolute target URL."""

    model_config = ConfigDict(extra="forbid")

    text: str
    url: str


class ImageRef(BaseModel):
    """Image alt text plus its resolved absolute source URL."""

    model_config = ConfigDict(extra="forbid")

    alt: str | None = None
    url: str


class AffordanceRole(StrEnum):
    """Semantic role of a described interactive affordance -- nothing more
    specific (no selector, no DOM path, no element tag) is ever recorded.
    """

    LINK = "link"
    BUTTON = "button"
    FORM = "form"


class Affordance(BaseModel):
    """A bounded, descriptive-only record of one visible interactive
    element the page exposes: what it is, not how to operate it.

    Only a semantic role, a visible label, a safe (``http``/``https``)
    destination when one exists, and a disabled flag are ever captured --
    never a selector, DOM path, script, form field value, or credential.
    Nothing in this model, or anywhere that consumes it, can be replayed
    to click, fill, or submit anything; that capability does not exist in
    this phase.
    """

    model_config = ConfigDict(extra="forbid")

    affordance_id: str
    role: AffordanceRole
    label: str
    destination: str | None = None
    disabled: bool = False


class Chunk(BaseModel):
    """A stable, bounded slice of the document's canonical flattened text."""

    model_config = ConfigDict(extra="forbid")

    chunk_id: str
    start_offset: int
    end_offset: int
    text: str
    block_ids: list[str]


class ExtractionLimits(BaseModel):
    """Configurable document/chunk/count bounds enforced during chunking."""

    model_config = ConfigDict(extra="forbid")

    max_total_chars: int = 50_000
    max_chunk_chars: int = 2_000
    max_chunks: int = 50


class ExtractedDocument(BaseModel):
    """The final structured, sanitized, bounded document."""

    model_config = ConfigDict(extra="forbid")

    metadata: DocumentMetadata
    blocks: list[ContentBlock]
    anchors: list[Anchor]
    images: list[ImageRef]
    affordances: list[Affordance]
    chunks: list[Chunk]
    warnings: list[ExtractionWarning]
    truncations: list[TruncationDetail]
    untrusted: Literal[True] = True
