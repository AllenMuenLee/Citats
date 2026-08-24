import type { ReactNode } from "react";
import { CitationMarker as CitationMarkerComponent, isSafeExternalUrl } from "../citations";
import type { CitationMarker, CitationSource } from "./chat-types";
import styles from "./chat.module.css";

type LineInfo = { start: number; end: number; raw: string };

/** Splits `text` into lines, tracking each line's absolute offset range (excluding its trailing "\n") in the original string. */
function splitLines(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      lines.push({ start, end: i, raw: text.slice(start, i) });
      start = i + 1;
    }
  }
  return lines;
}

type HeadingBlock = { type: "heading"; level: number; start: number; end: number };
type ParagraphBlock = { type: "paragraph"; start: number; end: number };
type CodeBlock = { type: "code"; start: number; end: number; lang: string };
type ListBlock = { type: "list"; ordered: boolean; items: { start: number; end: number }[] };
type QuoteBlock = { type: "quote"; start: number; end: number };
type HrBlock = { type: "hr" };
type Block = HeadingBlock | ParagraphBlock | CodeBlock | ListBlock | QuoteBlock | HrBlock;

const FENCE_OPEN_RE = /^ {0,3}(```|~~~)(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(?:```|~~~)\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(\s+(.*))?$/;
const HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_RE = /^ {0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;

/** Parses `text` (a raw assistant message, markdown syntax included) into a flat sequence of block-level nodes, each carrying the absolute character range of its own inline content within `text` -- so citation marker positions (recorded against that same raw text) stay valid without any offset translation. */
function parseBlocks(text: string): Block[] {
  const lines = splitLines(text);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.raw.trim() === "") { i++; continue; }

    const fence = FENCE_OPEN_RE.exec(line.raw);
    if (fence) {
      const lang = fence[2].trim();
      let j = i + 1;
      while (j < lines.length && !FENCE_CLOSE_RE.test(lines[j].raw)) j++;
      const codeStart = i + 1 < lines.length ? lines[i + 1].start : line.end;
      const codeEnd = j < lines.length ? (j > i + 1 ? lines[j - 1].end : codeStart) : lines[lines.length - 1].end;
      blocks.push({ type: "code", start: codeStart, end: codeEnd, lang });
      i = j < lines.length ? j + 1 : lines.length;
      continue;
    }

    const heading = HEADING_RE.exec(line.raw);
    if (heading) {
      const content = heading[3] ?? "";
      blocks.push({ type: "heading", level: heading[1].length, start: line.end - content.length, end: line.end });
      i++;
      continue;
    }

    if (HR_RE.test(line.raw)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const listStart = LIST_RE.exec(line.raw);
    if (listStart) {
      const ordered = /\d/.test(listStart[1]);
      const items: { start: number; end: number }[] = [];
      while (i < lines.length) {
        const match = LIST_RE.exec(lines[i].raw);
        if (!match || /\d/.test(match[1]) !== ordered) break;
        const content = match[2];
        items.push({ start: lines[i].end - content.length, end: lines[i].end });
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const quote = QUOTE_RE.exec(line.raw);
    if (quote) {
      const content = quote[1];
      blocks.push({ type: "quote", start: line.end - content.length, end: line.end });
      i++;
      continue;
    }

    let j = i;
    while (j < lines.length && lines[j].raw.trim() !== "" && !FENCE_OPEN_RE.test(lines[j].raw) && !HEADING_RE.test(lines[j].raw) && !HR_RE.test(lines[j].raw) && !LIST_RE.test(lines[j].raw) && !QUOTE_RE.test(lines[j].raw)) j++;
    blocks.push({ type: "paragraph", start: line.start, end: lines[j - 1].end });
    i = j;
  }
  return blocks;
}

/** Assigns each distinct `citationId` a stable 1-based display index in first-appearance order, shared across every block of one message. */
function indexCitations(markers: readonly CitationMarker[]): Map<string, number> {
  const sorted = [...markers].sort((a, b) => a.position - b.position);
  const index = new Map<string, number>();
  let next = 1;
  for (const marker of sorted) if (!index.has(marker.citationId)) index.set(marker.citationId, next++);
  return index;
}

const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*?)\*|(?<![\w`])_([^_\s][^_]*?)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Renders inline markdown (code spans, bold, italic, links) within one plain-text run. Does not see block structure or citation markers -- callers only ever pass it the text between two marker insertion points. */
function renderInlineSyntax(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let count = 0;
  INLINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_RE.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const key = `${keyPrefix}-i${count++}`;
    if (match[1] !== undefined) nodes.push(<code key={key} className={styles.inlineCode}>{match[1]}</code>);
    else if (match[2] !== undefined) nodes.push(<strong key={key}>{match[2]}</strong>);
    else if (match[3] !== undefined) nodes.push(<strong key={key}>{match[3]}</strong>);
    else if (match[4] !== undefined) nodes.push(<em key={key}>{match[4]}</em>);
    else if (match[5] !== undefined) nodes.push(<em key={key}>{match[5]}</em>);
    else if (match[6] !== undefined && match[7] !== undefined) {
      const url = match[7];
      nodes.push(isSafeExternalUrl(url)
        ? <a key={key} href={url} target="_blank" rel="noreferrer">{match[6]}</a>
        : <span key={key}>{match[6]}</span>);
    }
    lastIndex = INLINE_RE.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/**
 * Renders one block's inline content: slices it straight out of the
 * original message text (so a single soft line break inside a paragraph
 * collapses to a space, matching normal markdown reading, while the
 * character count -- and therefore every citation marker's position --
 * stays unchanged), splits it at any citation marker positions that fall
 * within this block, and runs the plain-text pieces through inline
 * markdown syntax.
 */
function renderBlockContent(text: string, start: number, end: number, markers: readonly CitationMarker[], citationIndex: Map<string, number>, sourceIndex: Map<string, CitationSource>, keyPrefix: string): ReactNode[] {
  const content = text.slice(start, end).replace(/\n/g, " ");
  const relevant = markers.filter((m) => m.position >= start && m.position <= end).sort((a, b) => a.position - b.position);
  if (relevant.length === 0) return renderInlineSyntax(content, keyPrefix);

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const marker of relevant) {
    const position = Math.max(0, Math.min(marker.position - start, content.length));
    if (position > cursor) nodes.push(...renderInlineSyntax(content.slice(cursor, position), `${keyPrefix}-t${cursor}`));
    nodes.push(<CitationMarkerComponent key={`${keyPrefix}-m-${marker.id}`} index={citationIndex.get(marker.citationId) ?? 0} source={sourceIndex.get(marker.sourceId)} />);
    cursor = position;
  }
  if (cursor < content.length) nodes.push(...renderInlineSyntax(content.slice(cursor), `${keyPrefix}-t${cursor}`));
  return nodes;
}

/** Renders an assistant message's raw text as markdown, with citation markers interleaved at their recorded positions. */
export function renderMarkdown(text: string, markers: readonly CitationMarker[] = [], sourceIndex: Map<string, CitationSource> = new Map()): ReactNode {
  const blocks = parseBlocks(text);
  const citationIndex = indexCitations(markers);
  return blocks.map((block, i) => {
    const key = `b${i}`;
    switch (block.type) {
      case "heading":
        return <div key={key} role="heading" aria-level={block.level} className={`${styles.heading} ${styles[`heading${Math.min(block.level, 6)}`]}`}>{renderBlockContent(text, block.start, block.end, markers, citationIndex, sourceIndex, key)}</div>;
      case "hr":
        return <hr key={key} className={styles.hr} />;
      case "code":
        return <pre key={key} className={styles.codeBlock}><code>{text.slice(block.start, block.end)}</code></pre>;
      case "quote":
        return <blockquote key={key} className={styles.blockquote}>{renderBlockContent(text, block.start, block.end, markers, citationIndex, sourceIndex, key)}</blockquote>;
      case "list": {
        const Tag: "ol" | "ul" = block.ordered ? "ol" : "ul";
        return <Tag key={key} className={styles.list}>{block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderBlockContent(text, item.start, item.end, markers, citationIndex, sourceIndex, `${key}-${itemIndex}`)}</li>)}</Tag>;
      }
      case "paragraph":
      default:
        return <p key={key}>{renderBlockContent(text, block.start, block.end, markers, citationIndex, sourceIndex, key)}</p>;
    }
  });
}
