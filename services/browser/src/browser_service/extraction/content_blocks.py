"""Build structured content blocks from an already-cleaned DOM subtree.

Traversal order is document order and deterministic: block-level elements
(headings, paragraphs, lists, tables) are recognized and turned into
:mod:`browser_service.extraction.models` blocks without recursing into
their own contents (their internal structure -- e.g. nested lists, table
rows -- is preserved *inside* the block itself); any other element (a
``div``/``section`` wrapper, etc.) is transparently recursed into so
blocks nested inside layout wrappers are still found in order.
"""

from __future__ import annotations

import itertools
from collections.abc import Iterator

from bs4.element import NavigableString, Tag

from browser_service.extraction.models import (
    ContentBlock,
    HeadingBlock,
    ListBlock,
    ListItem,
    ParagraphBlock,
    TableBlock,
    TableCell,
)
from browser_service.extraction.normalize import normalize_text

_HEADING_TAGS = frozenset({"h1", "h2", "h3", "h4", "h5", "h6"})


def extract_blocks(root: Tag) -> list[ContentBlock]:
    """Walk ``root`` and return an ordered list of content blocks."""
    counter = itertools.count()
    blocks: list[ContentBlock] = []
    _walk(root, blocks, counter)
    return blocks


def _next_id(counter: Iterator[int]) -> str:
    return f"block-{next(counter)}"


def _walk(node: Tag, blocks: list[ContentBlock], counter: Iterator[int]) -> None:
    for child in node.children:
        if not isinstance(child, Tag):
            continue
        name = child.name
        if name in _HEADING_TAGS:
            text = normalize_text(child.get_text(separator=" ", strip=True))
            if text:
                blocks.append(
                    HeadingBlock(block_id=_next_id(counter), level=int(name[1]), text=text)
                )
        elif name == "p":
            text = normalize_text(child.get_text(separator=" ", strip=True))
            if text:
                blocks.append(ParagraphBlock(block_id=_next_id(counter), text=text))
        elif name in ("ul", "ol"):
            list_block = _build_list(child, counter)
            if list_block.items:
                blocks.append(list_block)
        elif name == "table":
            table_block = _build_table(child, counter)
            if table_block.rows:
                blocks.append(table_block)
        else:
            _walk(child, blocks, counter)


def _build_list(tag: Tag, counter: Iterator[int]) -> ListBlock:
    ordered = tag.name == "ol"
    items: list[ListItem] = []
    for li in tag.find_all("li", recursive=False):
        nested_list: Tag | None = None
        for nested_candidate in li.find_all(("ul", "ol"), recursive=False):
            nested_list = nested_candidate
            break

        text_parts: list[str] = []
        for part in li.children:
            if isinstance(part, Tag) and part.name in ("ul", "ol"):
                continue
            if isinstance(part, NavigableString):
                text_parts.append(str(part))
            elif isinstance(part, Tag):
                text_parts.append(part.get_text(separator=" ", strip=True))
        text = normalize_text(" ".join(text_parts))
        children = _build_list(nested_list, counter) if nested_list is not None else None
        items.append(ListItem(text=text, children=children))
    return ListBlock(block_id=_next_id(counter), ordered=ordered, items=items)


def _build_table(tag: Tag, counter: Iterator[int]) -> TableBlock:
    rows: list[list[TableCell]] = []
    for tr in tag.find_all("tr"):
        cells: list[TableCell] = []
        for cell in tr.find_all(("td", "th"), recursive=False):
            text = normalize_text(cell.get_text(separator=" ", strip=True))
            cells.append(TableCell(text=text, is_header=cell.name == "th"))
        if cells:
            rows.append(cells)
    return TableBlock(block_id=_next_id(counter), rows=rows)


def block_flat_text(block: ContentBlock) -> str:
    """Return a canonical, flattened plain-text rendering of one block."""
    if isinstance(block, HeadingBlock):
        return block.text
    if isinstance(block, ParagraphBlock):
        return block.text
    if isinstance(block, ListBlock):
        return _list_flat_text(block, indent=0)
    if isinstance(block, TableBlock):
        return _table_flat_text(block)
    raise TypeError(f"unknown block type: {type(block)!r}")  # pragma: no cover


def _list_flat_text(block: ListBlock, indent: int) -> str:
    lines: list[str] = []
    for index, item in enumerate(block.items, start=1):
        bullet = f"{index}." if block.ordered else "-"
        lines.append(f"{'  ' * indent}{bullet} {item.text}".rstrip())
        if item.children is not None:
            lines.append(_list_flat_text(item.children, indent + 1))
    return "\n".join(lines)


def _table_flat_text(block: TableBlock) -> str:
    return "\n".join(" | ".join(cell.text for cell in row) for row in block.rows)
