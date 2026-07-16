import { renderMermaidASCII } from "beautiful-mermaid";
import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component
} from "@earendil-works/pi-tui";

import {
  isIncrementalTypescriptSource,
  isLineLocalFunctionScript,
  isLineLocalScript,
  isSingleFunctionScriptHeader
} from "./code-highlighter.ts";
import type { ZCodeTheme } from "./theme.ts";
import {
  sanitizeTerminalText,
  StreamingTerminalTextSanitizer,
  truncateGraphemes
} from "./terminal-text.ts";
import type { WindowedRenderResult } from "./renderable.ts";

export type MarkdownSegment =
  | { kind: "markdown"; text: string }
  | { kind: "mermaid"; source: string };

interface RenderedMarkdownSegment {
  segment: MarkdownSegment;
  component: Component;
}

interface MarkdownWindowPart {
  component?: Component;
  lineCount: number;
  start: number;
}

interface MarkdownWindowLayout {
  parts: MarkdownWindowPart[];
  text: string;
  totalLines: number;
  width: number;
}

const maxMermaidSourceCharacters = 20_000;
const markdownWindowChunkLines = 80;
const terminalWidthPlaceholder = "\u200b";
const inlineMarkdownSyntax = /[\\`*_[\]<>~&|]/u;
const markdownAutolinkSyntax = /(?:\b(?:[a-z][a-z0-9+.-]{1,31}:\/\/|www\.)|@)/iu;
const markdownBlockSyntax = /^(?: {4}|\t| {0,3}(?:#{1,6}(?:\s|$)|>|[+-](?:\s|$)|\d+[.)](?:\s|$)|-{3,}\s*$))/u;
const maxStreamingInlinePrefixCharacters = 4_096;
const maxStreamingStructuredLines = 10_000;
const maxStreamingStructuredSourceCharacters = 100_000;
const maxStreamingPresentationCharacters = 2_000_000;
const maxStreamingTableColumns = 8;
const maxInitialStreamingStableChunks = 64;
const maxStreamingTableRowCharacters = 1_024;
const maxStreamingTableProbeWidth = 4_096;

export function isPlainMarkdownBlock(text: string): boolean {
  return Boolean(text)
    && !text.includes("\n")
    && !text.includes("\t")
    && !inlineMarkdownSyntax.test(text)
    && !markdownAutolinkSyntax.test(text)
    && !markdownBlockSyntax.test(text);
}

interface StableInlineMarkdown {
  prefix: string;
  tail: string;
}

function stableInlineMarkdown(text: string): StableInlineMarkdown | undefined {
  if (!text || text.includes("\n") || text.includes("\t") || markdownBlockSyntax.test(text)) {
    return undefined;
  }
  let syntaxIndex = -1;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (!inlineMarkdownSyntax.test(text[index]!)) continue;
    syntaxIndex = index;
    break;
  }
  if (syntaxIndex < 0) return undefined;
  let tailStart = syntaxIndex + 1;
  while (tailStart < text.length && !/\s/u.test(text[tailStart]!)) tailStart += 1;
  if (tailStart >= text.length || tailStart > maxStreamingInlinePrefixCharacters) return undefined;
  const prefix = text.slice(0, tailStart);
  const tail = text.slice(tailStart);
  return isPlainMarkdownBlock(tail) ? { prefix, tail } : undefined;
}

function sameRenderedLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function normalizedOrderedListNumber(start: number, index: number): number | undefined {
  const marker = start + index;
  return marker <= 999_999_999 ? marker : undefined;
}

function flatUnorderedListLines(text: string): string[] | undefined {
  if (!text || text.includes("\t") || text.includes("\n\n")) return undefined;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length > 0 && lines.every((line) => /^[-+*] +\S.*$/u.test(line))
    ? lines
    : undefined;
}

function flatOrderedListLines(text: string): string[] | undefined {
  if (!text || text.includes("\t") || text.includes("\n\n")) return undefined;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > maxStreamingStructuredLines
    || text.length > maxStreamingStructuredSourceCharacters) {
    return undefined;
  }
  const ordered = lines.map((line) => /^(\d{1,9})([.)]) +(\S.*)$/u.exec(line));
  const first = ordered[0];
  if (!first?.[1] || !first[2]
    || ordered.some((item) => !item?.[3] || item[2] !== first[2])) {
    return undefined;
  }
  const start = Number(first[1]);
  if (normalizedOrderedListNumber(start, lines.length - 1) === undefined) return undefined;
  return ordered.map((item, index) => `${start + index}. ${item![3]}`);
}

function flatBlockquoteContents(text: string): string[] | undefined {
  if (!text || text.includes("\t") || text.includes("\n\n")) return undefined;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > maxStreamingStructuredLines
    || text.length > maxStreamingStructuredSourceCharacters) {
    return undefined;
  }
  const content = lines.map((line) => /^> (\S.*)$/u.exec(line)?.[1]);
  return content.every((line): line is string => typeof line === "string")
    ? content
    : undefined;
}

function hasAtMostPhysicalLines(text: string, maximumLines: number): boolean {
  let lines = text ? 1 : 0;
  let cursor = 0;
  while (lines <= maximumLines) {
    const lineEnd = text.indexOf("\n", cursor);
    if (lineEnd < 0) return true;
    if (lineEnd < text.length - 1) lines += 1;
    cursor = lineEnd + 1;
  }
  return false;
}

function flatPlainBlockquoteLines(text: string): string[] | undefined {
  const content = flatBlockquoteContents(text);
  return content?.every((line) => isPlainMarkdownBlock(line)) ? content : undefined;
}

function blockquoteContentsAtDepth(text: string, depth: number): string[] | undefined {
  let content: string[] | undefined = [text];
  for (let level = 0; level < depth; level += 1) {
    content = flatBlockquoteContents(content.join("\n"));
    if (!content) return undefined;
  }
  return content;
}

function isPlainInlineFragment(text: string): boolean {
  return !text || /^\s+$/u.test(text) || (!text.includes("\n")
    && !text.includes("\t")
    && !inlineMarkdownSyntax.test(text)
    && !markdownAutolinkSyntax.test(text));
}

function isLineLocalSemanticContent(text: string): boolean {
  if (!text || text.includes("\n") || text.includes("\t")
    || markdownBlockSyntax.test(text)) {
    return false;
  }
  let cursor = 0;
  let semantic = false;
  while (cursor < text.length) {
    const relativeMarker = text.slice(cursor).search(/[`*_~\[]/u);
    if (relativeMarker < 0) {
      return semantic && isPlainInlineFragment(text.slice(cursor));
    }
    const marker = cursor + relativeMarker;
    if (!isPlainInlineFragment(text.slice(cursor, marker))) return false;
    if (text[marker] === "[") {
      if (marker > 0 && text[marker - 1] === "!") return false;
      const labelEnd = text.indexOf("](", marker + 1);
      if (labelEnd < 0) return false;
      const close = text.indexOf(")", labelEnd + 2);
      if (close < 0) return false;
      const label = text.slice(marker + 1, labelEnd);
      const href = text.slice(labelEnd + 2, close);
      if (!label.trim() || !isPlainInlineFragment(label)
        || !href || /[\s()]/u.test(href)) {
        return false;
      }
      semantic = true;
      cursor = close + 1;
      continue;
    }
    const delimiter = text.startsWith("**", marker)
      ? "**"
      : text.startsWith("__", marker)
        ? "__"
        : text.startsWith("~~", marker)
          ? "~~"
          : text[marker] === "`"
            ? "`"
            : text[marker] === "*" || text[marker] === "_"
              ? text[marker]
              : undefined;
    if (!delimiter) return false;
    const close = text.indexOf(delimiter, marker + delimiter.length);
    if (close < 0) return false;
    const inner = text.slice(marker + delimiter.length, close);
    if (!inner.trim()) return false;
    if (delimiter !== "`" && !isPlainInlineFragment(inner)) return false;
    semantic = true;
    cursor = close + delimiter.length;
  }
  return semantic;
}

function stableListItemContent(text: string): boolean {
  const task = /^\[[ xX]\] +(\S.*)$/u.exec(text)?.[1];
  const content = task ?? text;
  return isPlainMarkdownBlock(content) || isLineLocalSemanticContent(content);
}

type RootListNestedContent = (
  line: string,
  currentChunk: readonly string[]
) => string | undefined;

type StreamingListSeparatorKind = "none" | "blank" | "quoted-blank";

interface StreamingListSources {
  separatorKind: StreamingListSeparatorKind;
  sources: string[];
}

function rootListChunks(
  text: string,
  maximumChunks: number,
  nestedContent: RootListNestedContent
): string[] | undefined {
  if (!text || text.includes("\t") || text.includes("\n\n")
    || text.length > maxStreamingStructuredSourceCharacters) {
    return undefined;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > maxStreamingStructuredLines) return undefined;

  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const parent = /^[-+*] (\S.*)$/u.exec(line)?.[1];
    if (parent) {
      if (!stableListItemContent(parent)) return undefined;
      if (current.length > 0) {
        if (current.length === 1) return undefined;
        chunks.push(current.join("\n"));
        if (chunks.length > maximumChunks) return undefined;
      }
      current = [line];
      continue;
    }

    const child = nestedContent(line, current);
    if (!child || current.length === 0 || !stableListItemContent(child)) return undefined;
    current.push(line);
  }
  if (current.length < 2) return undefined;
  chunks.push(current.join("\n"));
  return chunks.length <= maximumChunks ? chunks : undefined;
}

function rootNestedListChunks(
  text: string,
  maximumChunks = maxStreamingStructuredLines
): string[] | undefined {
  return rootListChunks(text, maximumChunks, nestedListChunkContent);
}

function rootListContinuationChunks(
  text: string,
  maximumChunks = maxStreamingStructuredLines
): string[] | undefined {
  return rootListChunks(text, maximumChunks, rootListContinuationContent);
}

function rootOrderedListContinuationChunks(
  text: string,
  maximumChunks = maxStreamingStructuredLines
): string[] | undefined {
  if (!text || text.includes("\t") || text.includes("\n\n")
    || text.length > maxStreamingStructuredSourceCharacters) {
    return undefined;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > maxStreamingStructuredLines) return undefined;

  const chunks: string[] = [];
  let currentContent: string | undefined;
  let currentContinuations: string[] = [];
  let delimiter: string | undefined;
  let start: number | undefined;
  const appendCurrent = (): boolean => {
    if (!currentContent || currentContinuations.length === 0 || start === undefined) return false;
    const marker = normalizedOrderedListNumber(start, chunks.length);
    if (marker === undefined) return false;
    chunks.push(`${marker}. ${currentContent}\n${currentContinuations.join("\n")}`);
    return chunks.length <= maximumChunks;
  };

  for (const line of lines) {
    const parent = /^(\d{1,9})([.)]) (\S.*)$/u.exec(line);
    if (parent?.[1] && parent[2] && parent[3]) {
      if (!stableListItemContent(parent[3])) return undefined;
      if (delimiter !== undefined && parent[2] !== delimiter) return undefined;
      if (currentContent !== undefined && !appendCurrent()) return undefined;
      delimiter ??= parent[2];
      start ??= Number(parent[1]);
      currentContent = parent[3];
      currentContinuations = [];
      continue;
    }

    const continuation = /^ {4}(\S.*)$/u.exec(line)?.[1];
    if (!continuation || currentContent === undefined
      || !stableListItemContent(continuation)) {
      return undefined;
    }
    currentContinuations.push(line);
  }
  return appendCurrent() ? chunks : undefined;
}

function rootOrderedNestedListChunks(
  text: string,
  maximumChunks = maxStreamingStructuredLines
): string[] | undefined {
  if (!text || text.includes("\t") || text.includes("\n\n")
    || text.length > maxStreamingStructuredSourceCharacters) {
    return undefined;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > maxStreamingStructuredLines) return undefined;

  const chunks: string[] = [];
  let currentContent: string | undefined;
  let currentChildren: string[] = [];
  let delimiter: string | undefined;
  let sourceChildIndent: number | undefined;
  let start: number | undefined;
  const appendCurrent = (): boolean => {
    if (!currentContent || currentChildren.length === 0 || start === undefined) return false;
    const marker = normalizedOrderedListNumber(start, chunks.length);
    if (marker === undefined) return false;
    const normalizedMarker = `${marker}.`;
    const childIndent = " ".repeat(normalizedMarker.length + 1);
    chunks.push([
      `${normalizedMarker} ${currentContent}`,
      ...currentChildren.map((child) => `${childIndent}${child}`)
    ].join("\n"));
    return chunks.length <= maximumChunks;
  };

  for (const line of lines) {
    const parent = /^(\d{1,9})([.)]) (\S.*)$/u.exec(line);
    if (parent?.[1] && parent[2] && parent[3]) {
      if (!stableListItemContent(parent[3])) return undefined;
      if (delimiter !== undefined && parent[2] !== delimiter) return undefined;
      if (currentContent !== undefined && !appendCurrent()) return undefined;
      delimiter ??= parent[2];
      start ??= Number(parent[1]);
      currentContent = parent[3];
      currentChildren = [];
      sourceChildIndent = parent[1].length + 2;
      continue;
    }

    if (currentContent === undefined || sourceChildIndent === undefined) return undefined;
    const indent = " ".repeat(sourceChildIndent);
    if (!line.startsWith(indent)) return undefined;
    const child = /^([-+*]) (\S.*)$/u.exec(line.slice(indent.length));
    if (!child?.[1] || !child[2] || !stableListItemContent(child[2])) return undefined;
    currentChildren.push(`${child[1]} ${child[2]}`);
  }
  return appendCurrent() ? chunks : undefined;
}

function looseRootOrderedListItems(
  text: string,
  maximumItems = maxStreamingStructuredLines
): string[] | undefined {
  if (!text || text.includes("\t") || !text.includes("\n\n")
    || text.length > maxStreamingStructuredSourceCharacters) {
    return undefined;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > maxStreamingStructuredLines) return undefined;

  const items: string[] = [];
  let delimiter: string | undefined;
  let expectItem = true;
  let separators = 0;
  let start: number | undefined;
  for (const line of lines) {
    if (expectItem) {
      const item = /^(\d{1,9})([.)]) (\S.*)$/u.exec(line);
      if (!item?.[1] || !item[2] || !item[3]
        || !stableListItemContent(item[3])
        || (delimiter !== undefined && item[2] !== delimiter)) {
        return undefined;
      }
      delimiter ??= item[2];
      start ??= Number(item[1]);
      const marker = normalizedOrderedListNumber(start, items.length);
      if (marker === undefined) return undefined;
      items.push(`${marker}. ${item[3]}`);
      if (items.length > maximumItems) return undefined;
      expectItem = false;
      continue;
    }
    if (line !== "") return undefined;
    separators += 1;
    expectItem = true;
  }

  const trailingSeparator = expectItem;
  const interItemSeparators = trailingSeparator ? separators - 1 : separators;
  return items.length >= 2 && interItemSeparators === items.length - 1
    ? items
    : undefined;
}

function looseRootNestedListChunks(
  text: string,
  maximumChunks = maxStreamingStructuredLines
): string[] | undefined {
  if (!text || text.includes("\t") || !text.includes("\n\n")
    || text.length > maxStreamingStructuredSourceCharacters) {
    return undefined;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > maxStreamingStructuredLines) return undefined;

  const chunks: string[] = [];
  let current: string[] | undefined;
  let hasChild = false;
  let pendingBlank = false;
  for (const line of lines) {
    if (line === "") {
      if (!current || pendingBlank) return undefined;
      pendingBlank = true;
      continue;
    }

    const parent = /^[-+*] (\S.*)$/u.exec(line)?.[1];
    const child = /^ {2}[-+*] (\S.*)$/u.exec(line)?.[1];
    if (!current) {
      if (!parent || !stableListItemContent(parent)) return undefined;
      current = [line];
      continue;
    }
    if (!pendingBlank) return undefined;
    if (child) {
      if (!stableListItemContent(child)) return undefined;
      current.push("", line);
      hasChild = true;
      pendingBlank = false;
      continue;
    }
    if (!parent || !hasChild || !stableListItemContent(parent)) return undefined;
    chunks.push(current.join("\n"));
    if (chunks.length > maximumChunks) return undefined;
    current = [line];
    hasChild = false;
    pendingBlank = false;
  }
  if (!current || !hasChild || pendingBlank) return undefined;
  chunks.push(current.join("\n"));
  return chunks.length <= maximumChunks ? chunks : undefined;
}

function nestedListChunkContent(
  line: string,
  currentChunk: readonly string[]
): string | undefined {
  const child = /^ {2}[-+*] (\S.*)$/u.exec(line)?.[1];
  if (child) return child;
  return currentChunk.length > 1
    ? /^ {4}(\S.*)$/u.exec(line)?.[1]
    : undefined;
}

function rootListContinuationContent(line: string): string | undefined {
  return /^ {2}(\S.*)$/u.exec(line)?.[1];
}

function adjacentListSources(sources: string[] | undefined): StreamingListSources | undefined {
  return sources ? { separatorKind: "none", sources } : undefined;
}

function streamingRootListSources(
  text: string,
  maximumStructuredChunks = maxStreamingStructuredLines
): StreamingListSources | undefined {
  const adjacent = flatUnorderedListLines(text)
    ?? flatOrderedListLines(text)
    ?? rootOrderedNestedListChunks(text, maximumStructuredChunks)
    ?? rootOrderedListContinuationChunks(text, maximumStructuredChunks)
    ?? rootNestedListChunks(text, maximumStructuredChunks)
    ?? rootListContinuationChunks(text, maximumStructuredChunks);
  if (adjacent) return { separatorKind: "none", sources: adjacent };
  const looseOrdered = looseRootOrderedListItems(text, maximumStructuredChunks);
  if (looseOrdered) return { separatorKind: "blank", sources: looseOrdered };
  const loose = looseRootNestedListChunks(text, maximumStructuredChunks);
  return loose ? { separatorKind: "blank", sources: loose } : undefined;
}

function flatSemanticBlockquoteLines(text: string): string[] | undefined {
  const content = flatBlockquoteContents(text);
  if (!content) return undefined;
  let semantic = false;
  for (const line of content) {
    if (isPlainMarkdownBlock(line)) continue;
    if (!isLineLocalSemanticContent(line)) return undefined;
    semantic = true;
  }
  return semantic ? content : undefined;
}

function nestedLineLocalBlockquoteLines(
  text: string,
  depth = 2,
  maximumLines = maxStreamingStructuredLines
): string[] | undefined {
  if (!hasAtMostPhysicalLines(text, maximumLines)) return undefined;
  const content = blockquoteContentsAtDepth(text, depth);
  if (!content || content.length > maximumLines) return undefined;
  for (const line of content) {
    if (!isPlainMarkdownBlock(line) && !isLineLocalSemanticContent(line)) return undefined;
  }
  return content;
}

type StableNestedBlockquoteDepth = 2 | 3 | 4;

function boundedBlockquoteDepth(text: string, maximumDepth: number): number | undefined {
  const lineEnd = text.indexOf("\n");
  const firstLine = text.slice(0, lineEnd < 0 ? text.length : lineEnd);
  let depth = 0;
  let cursor = 0;
  while (firstLine.startsWith("> ", cursor)) {
    depth += 1;
    cursor += 2;
    if (depth > maximumDepth) return undefined;
  }
  return depth > 0 ? depth : undefined;
}

interface StableNestedBlockquote {
  depth: StableNestedBlockquoteDepth;
  lines: string[];
}

function stableNestedBlockquote(
  text: string,
  maximumLines = maxStreamingStructuredLines
): StableNestedBlockquote | undefined {
  const depth = boundedBlockquoteDepth(text, 4);
  if (!depth || depth < 2) return undefined;
  const lines = nestedLineLocalBlockquoteLines(text, depth, maximumLines);
  return lines
    ? { depth: depth as StableNestedBlockquoteDepth, lines }
    : undefined;
}

function flatQuotedListLines(text: string): string[] | undefined {
  const content = flatBlockquoteContents(text);
  if (!content) return undefined;
  if (content.every((line) => /^[-+*] +\S.*$/u.test(line))) {
    return content.map((line) => `> ${line}`);
  }
  const ordered = content.map((line) => /^(\d{1,9})([.)]) +(\S.*)$/u.exec(line));
  const first = ordered[0];
  if (!first?.[1] || !first[2]
    || ordered.some((item) => !item?.[3] || item[2] !== first[2])) {
    return undefined;
  }
  const start = Number(first[1]);
  if (start + content.length - 1 > 999_999_999) return undefined;
  return ordered.map((item, index) => `> ${start + index}. ${item![3]}`);
}

function nestedQuotedListLines(text: string): string[] | undefined {
  const depth = boundedBlockquoteDepth(text, 3);
  if (!depth || depth < 2) return undefined;
  const innerContent = blockquoteContentsAtDepth(text, depth);
  if (!innerContent) return undefined;
  const innerItems = flatQuotedListLines(innerContent.map((line) => `> ${line}`).join("\n"));
  const outerPrefix = "> ".repeat(depth - 1);
  return innerItems?.map((line) => `${outerPrefix}${line}`);
}

function quotedListContinuationChunks(text: string): string[] | undefined {
  if (!text || text.includes("\t") || text.includes("\n\n")
    || text.length > maxStreamingStructuredSourceCharacters) {
    return undefined;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > maxStreamingStructuredLines) return undefined;

  const chunks: string[] = [];
  let current: string[] = [];
  let hasContinuation = false;
  for (const line of lines) {
    if (/^> [-+*] +\S.*$/u.test(line)) {
      if (current.length > 0) chunks.push(current.join("\n"));
      current = [line];
      continue;
    }
    const continuation = /^> {3}(\S.*)$/u.exec(line)?.[1];
    if (!continuation || current.length === 0
      || (!isPlainMarkdownBlock(continuation)
        && !isLineLocalSemanticContent(continuation))) {
      return undefined;
    }
    current.push(line);
    hasContinuation = true;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return hasContinuation ? chunks : undefined;
}

function looseQuotedListItems(
  text: string,
  maximumItems = maxStreamingStructuredLines
): string[] | undefined {
  if (!text || text.includes("\t") || text.includes("\n\n")
    || text.length > maxStreamingStructuredSourceCharacters) {
    return undefined;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > maxStreamingStructuredLines) return undefined;

  const items: string[] = [];
  let expectItem = true;
  let separators = 0;
  for (const line of lines) {
    if (expectItem) {
      const content = /^> [-+*] (\S.*)$/u.exec(line)?.[1];
      if (!content || !stableListItemContent(content)) return undefined;
      items.push(line);
      if (items.length > maximumItems) return undefined;
      expectItem = false;
      continue;
    }
    if (line !== ">") return undefined;
    separators += 1;
    expectItem = true;
  }

  const trailingSeparator = expectItem;
  const interItemSeparators = trailingSeparator ? separators - 1 : separators;
  return items.length >= 2 && interItemSeparators === items.length - 1
    ? items
    : undefined;
}

function streamingQuotedListLines(text: string): string[] | undefined {
  return flatQuotedListLines(text)
    ?? nestedQuotedListLines(text)
    ?? quotedListContinuationChunks(text);
}

function streamingQuotedListSources(
  text: string,
  maximumSources = maxStreamingStructuredLines
): StreamingListSources | undefined {
  const loose = looseQuotedListItems(text, maximumSources);
  if (loose) return { separatorKind: "quoted-blank", sources: loose };
  const sources = streamingQuotedListLines(text);
  return sources && sources.length <= maximumSources
    ? adjacentListSources(sources)
    : undefined;
}

type CrossLineSemanticDelimiter = "**" | "__" | "~~" | "`" | "*" | "_";
type CrossLineBlockquoteDepth = 1 | 2 | 3;

interface CrossLineSemanticBlockquote {
  chunks: string[];
  depth: CrossLineBlockquoteDepth;
}

interface ActiveCrossLineSemanticDelimiter {
  delimiter: CrossLineSemanticDelimiter;
  hasContent: boolean;
  openedLine: number;
}

function crossLineSemanticBlockquoteChunks(
  text: string,
  quoteDepth: CrossLineBlockquoteDepth,
  maximumChunks = maxStreamingStructuredLines
): string[] | undefined {
  const content = quoteDepth > 1
    ? blockquoteContentsAtDepth(text, quoteDepth)
    : flatBlockquoteContents(text);
  if (!content) return undefined;
  const quotePrefix = quoteSourcePrefix(quoteDepth);
  const chunks: string[] = [];
  let chunkLines: string[] = [];
  let active: ActiveCrossLineSemanticDelimiter | undefined;
  let crossedLine = false;

  for (const [lineIndex, line] of content.entries()) {
    if (markdownBlockSyntax.test(line)) return undefined;
    let cursor = 0;
    while (cursor < line.length) {
      if (active) {
        const close = line.indexOf(active.delimiter, cursor);
        if (close < 0) {
          const rest = line.slice(cursor);
          if (active.delimiter !== "`" && !isPlainInlineFragment(rest)) return undefined;
          active.hasContent ||= Boolean(rest.trim());
          cursor = line.length;
          continue;
        }
        const inner = line.slice(cursor, close);
        if (active.delimiter !== "`" && !isPlainInlineFragment(inner)) return undefined;
        const beforeClose = line[close - 1];
        const afterClose = line[close + active.delimiter.length];
        if (!beforeClose || /\s/u.test(beforeClose)
          || (afterClose && /[\p{L}\p{N}]/u.test(afterClose))) {
          return undefined;
        }
        active.hasContent ||= Boolean(inner.trim());
        if (!active.hasContent) return undefined;
        crossedLine ||= lineIndex > active.openedLine;
        cursor = close + active.delimiter.length;
        active = undefined;
        continue;
      }

      const relativeMarker = line.slice(cursor).search(/[`*_~]/u);
      if (relativeMarker < 0) {
        if (!isPlainInlineFragment(line.slice(cursor))) return undefined;
        cursor = line.length;
        continue;
      }
      const marker = cursor + relativeMarker;
      if (!isPlainInlineFragment(line.slice(cursor, marker))) return undefined;
      const delimiter: CrossLineSemanticDelimiter | undefined = line.startsWith("**", marker)
        ? "**"
        : line.startsWith("__", marker)
          ? "__"
          : line.startsWith("~~", marker)
            ? "~~"
            : line[marker] === "`" || line[marker] === "*" || line[marker] === "_"
              ? line[marker] as CrossLineSemanticDelimiter
              : undefined;
      if (!delimiter) return undefined;
      const beforeOpen = line[marker - 1];
      const afterOpen = line[marker + delimiter.length];
      if (!afterOpen || /\s/u.test(afterOpen)
        || (beforeOpen && /[\p{L}\p{N}]/u.test(beforeOpen))) {
        return undefined;
      }
      active = { delimiter, hasContent: false, openedLine: lineIndex };
      cursor = marker + delimiter.length;
    }

    chunkLines.push(`${quotePrefix}${line}`);
    if (!active) {
      chunks.push(chunkLines.join("\n"));
      if (chunks.length > maximumChunks) return undefined;
      chunkLines = [];
    }
  }

  if (!crossedLine || chunks.length === 0) return undefined;
  if (chunkLines.length > 0) {
    chunks.push(chunkLines.join("\n"));
    if (chunks.length > maximumChunks) return undefined;
  }
  return chunks;
}

function crossLineSemanticBlockquote(
  text: string,
  maximumChunks = maxStreamingStructuredLines
): CrossLineSemanticBlockquote | undefined {
  const maximumPhysicalLines = Math.min(
    maxStreamingStructuredLines,
    maximumChunks * 2
  );
  if (!hasAtMostPhysicalLines(text, maximumPhysicalLines)) return undefined;
  const depth = boundedBlockquoteDepth(text, 3);
  if (!depth) return undefined;
  const chunks = crossLineSemanticBlockquoteChunks(
    text,
    depth as CrossLineBlockquoteDepth,
    maximumChunks
  );
  return chunks
    ? { chunks, depth: depth as CrossLineBlockquoteDepth }
    : undefined;
}

interface StrictStreamingTableRow {
  cells: string[];
  source: string;
}

interface StrictStreamingTable {
  delimiter: string;
  header: StrictStreamingTableRow;
  rows: StrictStreamingTableRow[];
}

function strictPipeTableCells(line: string): string[] | undefined {
  if (line.length > maxStreamingTableRowCharacters
    || !line.startsWith("|")
    || !line.endsWith("|")
    || line.includes("\\")) {
    return undefined;
  }
  const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
  return cells.length >= 2
    && cells.length <= maxStreamingTableColumns
    && cells.every(Boolean)
    ? cells
    : undefined;
}

function strictStreamingTable(
  text: string,
  maximumRows = maxStreamingStructuredLines
): StrictStreamingTable | undefined {
  if (!text || text.includes("\t") || text.includes("\n\n")
    || text.length > maxStreamingStructuredSourceCharacters) {
    return undefined;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 3
    || lines.length > maxStreamingStructuredLines
    || lines.length - 2 > maximumRows) {
    return undefined;
  }

  const headerCells = strictPipeTableCells(lines[0]!);
  const delimiterCells = strictPipeTableCells(lines[1]!);
  if (!headerCells || !delimiterCells || delimiterCells.length !== headerCells.length
    || !headerCells.every((cell) => isPlainMarkdownBlock(cell))
    || !delimiterCells.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
    return undefined;
  }

  const rows: StrictStreamingTableRow[] = [];
  for (const source of lines.slice(2)) {
    const cells = strictPipeTableCells(source);
    if (!cells || cells.length !== headerCells.length
      || cells.some((cell) => !isPlainMarkdownBlock(cell)
        && !isLineLocalSemanticContent(cell))) {
      return undefined;
    }
    rows.push({ cells, source });
  }
  return {
    delimiter: lines[1]!,
    header: { cells: headerCells, source: lines[0]! },
    rows
  };
}

type StreamingFenceHighlightMode = "line-local" | "whole-source";

interface StrictStreamingFence {
  allowPartialLastLine: boolean;
  code: string;
  codeLines: string[];
  highlightMode: StreamingFenceHighlightMode;
  language: string;
  lineContexts?: string[];
}

interface StrictQuotedStreamingFence {
  codeLines: string[];
  language: string;
  lineContexts?: string[];
  opening: string;
  quoteDepth: 1 | 2 | 3 | 4;
}

const singleFunctionTypeScriptFenceOpening = /^(`{3,}|~{3,})[ ]*(ts|typescript)[ ]*$/iu;
const strictLineLocalFenceOpening = /^(`{3,}|~{3,})[ ]*(bash|js|javascript|json|py|python|sh)[ ]*$/iu;
const strictStreamingFenceOpening = /^(`{3,}|~{3,})[ ]*(bash|js|javascript|json|py|python|sh|ts|typescript)[ ]*$/iu;
const jsxLikeJavaScript = /(?:<[/]?[A-Za-z][\w.-]*(?:\s|[/]?>)|<>|<[/]>)/u;
const unsafeBashWords = new Set([
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "select",
  "then",
  "until",
  "while"
]);

function isLineLocalJavaScript(source: string): boolean {
  return isLineLocalScript(source) && !jsxLikeJavaScript.test(source);
}

function isLineLocalJavaScriptFunction(
  source: string,
  allowPartialLastLine: boolean
): boolean {
  return !jsxLikeJavaScript.test(source)
    && isLineLocalFunctionScript(source, allowPartialLastLine);
}

function hasSingleFunctionTypeScriptFenceHeader(text: string): boolean {
  const openingEnd = text.indexOf("\n");
  if (openingEnd < 0 || !singleFunctionTypeScriptFenceOpening.test(text.slice(0, openingEnd))) {
    return false;
  }
  const headerStart = openingEnd + 1;
  const headerEnd = text.indexOf("\n", headerStart);
  return isSingleFunctionScriptHeader(
    text.slice(headerStart, headerEnd < 0 ? text.length : headerEnd)
  );
}

type StrictJsonDelimiter = "{" | "[";

interface StrictJsonLineScan {
  complete: boolean;
  delimiters: StrictJsonDelimiter[];
  hasToken: boolean;
  topLevelColon: boolean;
}

function strictJsonStringEnd(
  line: string,
  start: number,
  allowIncomplete: boolean
): number | "incomplete" | undefined {
  for (let index = start + 1; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === "\"") return index + 1;
    if (character.charCodeAt(0) < 0x20) return undefined;
    if (character !== "\\") continue;
    const escaped = line[index + 1];
    if (escaped === undefined) return allowIncomplete ? "incomplete" : undefined;
    if (/^["\\/bfnrt]$/u.test(escaped)) {
      index += 1;
      continue;
    }
    if (escaped !== "u") return undefined;
    const digits = line.slice(index + 2, index + 6);
    if (digits.length < 4) {
      return allowIncomplete && /^[0-9a-f]*$/iu.test(digits) ? "incomplete" : undefined;
    }
    if (!/^[0-9a-f]{4}$/iu.test(digits)) return undefined;
    index += 5;
  }
  return allowIncomplete ? "incomplete" : undefined;
}

function strictJsonNumberEnd(
  line: string,
  start: number,
  allowIncomplete: boolean
): number | "incomplete" | undefined {
  let index = start;
  if (line[index] === "-") index += 1;
  if (index >= line.length) return allowIncomplete ? "incomplete" : undefined;
  if (line[index] === "0") {
    index += 1;
    if (/\d/u.test(line[index] ?? "")) return undefined;
  } else if (/[1-9]/u.test(line[index] ?? "")) {
    index += 1;
    while (/\d/u.test(line[index] ?? "")) index += 1;
  } else {
    return undefined;
  }
  if (line[index] === ".") {
    index += 1;
    if (!/\d/u.test(line[index] ?? "")) {
      return allowIncomplete && index >= line.length ? "incomplete" : undefined;
    }
    while (/\d/u.test(line[index] ?? "")) index += 1;
  }
  if (line[index] === "e" || line[index] === "E") {
    index += 1;
    if (line[index] === "+" || line[index] === "-") index += 1;
    if (!/\d/u.test(line[index] ?? "")) {
      return allowIncomplete && index >= line.length ? "incomplete" : undefined;
    }
    while (/\d/u.test(line[index] ?? "")) index += 1;
  }
  return index;
}

function strictJsonKeywordEnd(
  line: string,
  start: number,
  allowIncomplete: boolean
): number | "incomplete" | undefined {
  for (const keyword of ["true", "false", "null"]) {
    if (line.startsWith(keyword, start)) return start + keyword.length;
    const suffix = line.slice(start);
    if (allowIncomplete && keyword.startsWith(suffix)) return "incomplete";
  }
  return undefined;
}

function scanStrictJsonLine(
  line: string,
  allowIncomplete = false,
  initialDelimiters: readonly StrictJsonDelimiter[] = []
): StrictJsonLineScan | undefined {
  const delimiters = [...initialDelimiters];
  const initialDepth = delimiters.length;
  let hasToken = false;
  let topLevelColon = false;

  for (let index = 0; index < line.length;) {
    const character = line[index]!;
    if (character === " ") {
      index += 1;
      continue;
    }
    if (character === "\"") {
      const end = strictJsonStringEnd(line, index, allowIncomplete);
      if (end === "incomplete") {
        return { complete: false, delimiters, hasToken: true, topLevelColon };
      }
      if (end === undefined) return undefined;
      hasToken = true;
      index = end;
      continue;
    }
    if (character === "{" || character === "[") {
      delimiters.push(character);
      hasToken = true;
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      const opening = delimiters.pop();
      if ((character === "}" && opening !== "{")
        || (character === "]" && opening !== "[")) {
        return undefined;
      }
      hasToken = true;
      index += 1;
      continue;
    }
    if (character === ":") {
      if (delimiters.length === initialDepth) topLevelColon = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      index += 1;
      continue;
    }
    if (character === "-" || /\d/u.test(character)) {
      const end = strictJsonNumberEnd(line, index, allowIncomplete);
      if (end === "incomplete") {
        return { complete: false, delimiters, hasToken: true, topLevelColon };
      }
      if (end === undefined) return undefined;
      hasToken = true;
      index = end;
      continue;
    }
    if (character === "t" || character === "f" || character === "n") {
      const end = strictJsonKeywordEnd(line, index, allowIncomplete);
      if (end === "incomplete") {
        return { complete: false, delimiters, hasToken: true, topLevelColon };
      }
      if (end === undefined) return undefined;
      hasToken = true;
      index = end;
      continue;
    }
    return undefined;
  }
  return {
    complete: delimiters.length === initialDepth,
    delimiters,
    hasToken,
    topLevelColon
  };
}

function closesStrictJsonContainer(line: string, opening: StrictJsonDelimiter): boolean {
  return opening === "{" ? /^\},?$/u.test(line) : /^\],?$/u.test(line);
}

function strictJsonLineContexts(
  lines: string[],
  allowPartialLastLine: boolean
): string[] | undefined {
  if (lines.length === 0) return undefined;
  const opening = lines[0]!.trim();
  if (opening !== "{" && opening !== "[") {
    const contexts: string[] = [];
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) {
        contexts.push("");
        continue;
      }
      const allowIncomplete = allowPartialLastLine && index === lines.length - 1;
      const scanned = scanStrictJsonLine(line, allowIncomplete);
      if (!scanned?.hasToken || (!scanned.complete && !allowIncomplete)
        || scanned.topLevelColon) {
        return undefined;
      }
      contexts.push("");
    }
    return contexts;
  }

  const closing = opening === "{" ? "}" : "]";
  const contexts = [""];
  let delimiters: StrictJsonDelimiter[] = [opening];
  let closed = false;
  let nestedBodyLines = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    const context = delimiters.at(-1) ?? "";
    if (!trimmed) {
      contexts.push(context);
      continue;
    }
    if (trimmed === closing && delimiters.length === 1) {
      if (closed || lines.slice(index + 1).some((candidate) => candidate.trim())) {
        return undefined;
      }
      contexts.push(context);
      delimiters = [];
      closed = true;
      continue;
    }
    if (closed) return undefined;
    const allowIncomplete = allowPartialLastLine && index === lines.length - 1;
    const before = delimiters;
    const scanned = scanStrictJsonLine(line, allowIncomplete, before);
    if (!scanned?.hasToken) return undefined;

    if (before.length === 2 && closesStrictJsonContainer(trimmed, before[1]!)) {
      if (nestedBodyLines === 0 || scanned.delimiters.length !== 1) return undefined;
      contexts.push(context);
      delimiters = scanned.delimiters;
      nestedBodyLines = 0;
      continue;
    }

    const openedNested = before.length === 1 && scanned.delimiters.length === 2;
    if (scanned.delimiters.length < before.length
      || scanned.delimiters.length > 2
      || (!scanned.complete && !allowIncomplete && !openedNested)
      || (before.at(-1) === "{" && !scanned.topLevelColon && !allowIncomplete)
      || (openedNested && !allowIncomplete
        && !trimmed.endsWith(scanned.delimiters.at(-1)!))) {
      return undefined;
    }
    if (before.length === 2) {
      if (scanned.delimiters.length !== 2) return undefined;
      if (!allowIncomplete) nestedBodyLines += 1;
    } else if (openedNested) {
      nestedBodyLines = 0;
    }
    contexts.push(context);
    delimiters = scanned.delimiters;
  }
  return contexts;
}

function isUnsafeBashWord(line: string, start: number | undefined, end: number): boolean {
  return start !== undefined && unsafeBashWords.has(line.slice(start, end));
}

function isLineLocalBashLine(line: string, allowIncomplete = false): boolean {
  let codeEnd = line.length;
  let wordActive = false;
  let wordStart: number | undefined;
  const finishWord = (end: number): boolean => {
    const unsafe = isUnsafeBashWord(line, wordStart, end);
    wordActive = false;
    wordStart = undefined;
    return !unsafe;
  };

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === " ") {
      if (!finishWord(index)) return false;
      continue;
    }
    if (character === "#") {
      if (!wordActive) {
        if (!finishWord(index)) return false;
        codeEnd = index;
        break;
      }
      wordStart ??= index;
      continue;
    }
    if (character === "'" || character === "\"") {
      if (!finishWord(index)) return false;
      const quote = character;
      let closed = false;
      for (index += 1; index < line.length; index += 1) {
        const quoted = line[index]!;
        if (quote === "\"" && (quoted === "$" || quoted === "`")) return false;
        if (quote === "\"" && quoted === "\\") {
          if (index + 1 >= line.length) return allowIncomplete;
          index += 1;
          continue;
        }
        if (quoted !== quote) continue;
        closed = true;
        break;
      }
      if (!closed) return allowIncomplete;
      wordActive = true;
      continue;
    }
    if (character === "\\") {
      if (!finishWord(index)) return false;
      if (index + 1 >= line.length) return allowIncomplete;
      index += 1;
      wordActive = true;
      continue;
    }
    if (character === "$" || character === "`"
      || character === "(" || character === ")"
      || character === "{" || character === "}"
      || character === "[" || character === "]") {
      return false;
    }
    if (character === "<") {
      if (line[index + 1] === "<" || line[index + 1] === "(") return false;
      if (!finishWord(index)) return false;
      continue;
    }
    if (character === ">") {
      if (line[index + 1] === "(") return false;
      if (!finishWord(index)) return false;
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      if (!finishWord(index)) return false;
      continue;
    }
    wordActive = true;
    wordStart ??= index;
  }
  if (!finishWord(line.length)) return false;
  const trimmed = line.slice(0, codeEnd).trimEnd();
  return allowIncomplete || !/(?:&&|\|\||\|)$/u.test(trimmed);
}

const simplePythonFStringField = /^(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+(?:\.\d+)?)(?:![rsa])?(?::[^{}"'\\\r\n]+)?$/u;

function simplePythonFStringEnd(line: string, quoteIndex: number): number | undefined {
  const quote = line[quoteIndex];
  if (quote !== "\"" && quote !== "'") return undefined;
  let fieldStart: number | undefined;

  for (let index = quoteIndex + 1; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === "\\") {
      if (fieldStart !== undefined || index + 1 >= line.length) return undefined;
      index += 1;
      continue;
    }
    if (character === quote) {
      return fieldStart === undefined ? index : undefined;
    }
    if (character === "{") {
      if (fieldStart === undefined && line[index + 1] === "{") {
        index += 1;
        continue;
      }
      if (fieldStart !== undefined) return undefined;
      fieldStart = index + 1;
      continue;
    }
    if (character !== "}") continue;
    if (fieldStart === undefined) {
      if (line[index + 1] !== "}") return undefined;
      index += 1;
      continue;
    }
    if (!simplePythonFStringField.test(line.slice(fieldStart, index))) return undefined;
    fieldStart = undefined;
  }
  return undefined;
}

function isLineLocalPythonLine(line: string): boolean {
  if (line.includes("\"\"\"") || line.includes("'''")
    || /(?:^|[^\p{L}\p{N}_])(?:fr|rf)["']/iu.test(line)
    || /\\\s*$/u.test(line)) {
    return false;
  }
  const delimiters: Array<"(" | "[" | "{"> = [];
  let escaped = false;
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "#") break;
    if (character === "\"" || character === "'") {
      const prefix = line[index - 1];
      const beforePrefix = line[index - 2];
      if ((prefix === "f" || prefix === "F")
        && (beforePrefix === undefined || !/[.\p{L}\p{N}_]/u.test(beforePrefix))) {
        const end = simplePythonFStringEnd(line, index);
        if (end === undefined) return false;
        index = end;
        continue;
      }
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      delimiters.push(character);
      continue;
    }
    if (character !== ")" && character !== "]" && character !== "}") continue;
    const opening = delimiters.pop();
    if ((character === ")" && opening !== "(")
      || (character === "]" && opening !== "[")
      || (character === "}" && opening !== "{")) {
      return false;
    }
  }
  return quote === undefined && delimiters.length === 0;
}

function strictStreamingFence(
  text: string,
  codeHighlightingEnabled = true,
  maximumLineLocalLines = maxStreamingStructuredLines
): StrictStreamingFence | undefined {
  if (!codeHighlightingEnabled) {
    const openingEnd = text.indexOf("\n");
    const openingLine = text.slice(0, openingEnd < 0 ? text.length : openingEnd);
    if (strictLineLocalFenceOpening.test(openingLine)
      || hasSingleFunctionTypeScriptFenceHeader(text)) {
      return undefined;
    }
  }
  const containsTab = text.includes("\t");
  const normalized = text.replace(/\t/gu, "   ");
  const lines = normalized.split("\n");
  const opening = strictStreamingFenceOpening.exec(lines[0] ?? "");
  const marker = opening?.[1];
  const language = opening?.[2];
  if (!marker || !language) return undefined;
  const normalizedLanguage = language.toLowerCase();
  const bash = normalizedLanguage === "bash" || normalizedLanguage === "sh";
  const javascript = normalizedLanguage === "js" || normalizedLanguage === "javascript";
  const json = normalizedLanguage === "json";
  const python = normalizedLanguage === "py" || normalizedLanguage === "python";
  if ((bash || javascript || json || python)
    && (containsTab || !codeHighlightingEnabled)) return undefined;

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (closesFence(lines[index] ?? "", marker[0] as "`" | "~", marker.length)) {
      closingIndex = index;
      break;
    }
  }

  let allowPartialLastLine = false;
  let codeLines: string[];
  if (closingIndex >= 0) {
    const trailingLines = lines.slice(closingIndex + 1);
    if (trailingLines.length > 1 || trailingLines.some(Boolean)) return undefined;
    codeLines = lines.slice(1, closingIndex);
  } else {
    codeLines = lines.slice(1);
    const lastLine = codeLines.at(-1);
    if (lastLine && lastLine.length < marker.length
      && lastLine === marker[0]!.repeat(lastLine.length)) {
      codeLines.pop();
    } else if (normalized.endsWith("\n")) {
      codeLines.pop();
    } else {
      allowPartialLastLine = true;
    }
  }

  const code = codeLines.join("\n");
  if (!code || code.length > maxStreamingStructuredSourceCharacters) return undefined;
  if (bash) {
    if (codeLines.length > maximumLineLocalLines
      || !codeLines.every((line, index) => isLineLocalBashLine(
        line,
        allowPartialLastLine && index === codeLines.length - 1
      ))) {
      return undefined;
    }
    return { allowPartialLastLine, code, codeLines, highlightMode: "line-local", language };
  }
  if (javascript) {
    if (codeLines.length > maximumLineLocalLines
      || (!isLineLocalJavaScript(code)
        && !isLineLocalJavaScriptFunction(code, allowPartialLastLine))) {
      return undefined;
    }
    return { allowPartialLastLine, code, codeLines, highlightMode: "line-local", language };
  }
  if (json) {
    const lineContexts = strictJsonLineContexts(codeLines, allowPartialLastLine);
    if (codeLines.length > maximumLineLocalLines || !lineContexts) return undefined;
    return {
      allowPartialLastLine,
      code,
      codeLines,
      highlightMode: "line-local",
      language,
      lineContexts
    };
  }
  if (python) {
    if (codeLines.length > maximumLineLocalLines
      || !codeLines.every((line) => isLineLocalPythonLine(line))) {
      return undefined;
    }
    return { allowPartialLastLine, code, codeLines, highlightMode: "line-local", language };
  }
  if (codeLines.length > maxStreamingStructuredLines || !isIncrementalTypescriptSource(code)) {
    return undefined;
  }
  return { allowPartialLastLine, code, codeLines, highlightMode: "whole-source", language };
}

function strictQuotedStreamingFence(
  text: string,
  maximumLines = maxStreamingStructuredLines
): StrictQuotedStreamingFence | undefined {
  if (!text || text.includes("\t")
    || text.length > maxStreamingStructuredSourceCharacters) {
    return undefined;
  }
  const quotedLines = text.split("\n");
  const firstLine = quotedLines[0] ?? "";
  let detectedDepth = 0;
  while (detectedDepth <= 4
    && firstLine.startsWith("> ".repeat(detectedDepth + 1))) {
    detectedDepth += 1;
  }
  if (detectedDepth < 1 || detectedDepth > 4) return undefined;
  const quoteDepth = detectedDepth as 1 | 2 | 3 | 4;
  const sourcePrefix = "> ".repeat(quoteDepth);
  const innerLines: string[] = [];
  for (const [index, line] of quotedLines.entries()) {
    if (index === quotedLines.length - 1
      && line.length < sourcePrefix.length
      && sourcePrefix.startsWith(line)) {
      innerLines.push("");
      continue;
    }
    if (!line.startsWith(sourcePrefix)) return undefined;
    const inner = line.slice(sourcePrefix.length);
    if (index > 0 && inner.startsWith("> ")) return undefined;
    innerLines.push(inner);
  }
  const opening = innerLines[0];
  if (!opening) return undefined;
  const fence = strictStreamingFence(
    innerLines.join("\n"),
    true,
    maximumLines
  );
  const language = fence?.language.toLowerCase();
  const lineLocalTypeScript = fence?.highlightMode === "whole-source"
    && (language === "ts" || language === "typescript")
    && (isLineLocalScript(fence.code)
      || (quoteDepth === 1
        && isLineLocalFunctionScript(fence.code, fence.allowPartialLastLine)));
  const lineLocalJavaScript = fence?.highlightMode === "line-local"
    && quoteDepth === 1
    && (language === "js" || language === "javascript");
  const lineLocalPython = fence?.highlightMode === "line-local"
    && quoteDepth === 1
    && (language === "py" || language === "python");
  const lineLocalJson = fence?.highlightMode === "line-local"
    && quoteDepth === 1
    && language === "json";
  const lineLocalBash = fence?.highlightMode === "line-local"
    && quoteDepth === 1
    && (language === "bash" || language === "sh");
  if (!fence || fence.codeLines.length > maximumLines
    || (!lineLocalTypeScript && !lineLocalBash && !lineLocalJavaScript
      && !lineLocalJson && !lineLocalPython)) {
    return undefined;
  }
  return {
    codeLines: fence.codeLines,
    language: fence.language,
    lineContexts: fence.lineContexts,
    opening,
    quoteDepth
  };
}

class StreamingPlainText implements Component {
  private cachedText?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private renderedText = "";
  private renderedWidth?: number;
  private stableLines: string[] = [];
  private lastWrappedLine?: string;

  constructor(
    private text: string,
    private readonly paddingX: number
  ) {}

  setText(text: string): void {
    if (text === this.text) return;
    if (!text.startsWith(this.text)) this.resetWrapping();
    this.text = text;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.resetWrapping();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const canAppend = this.renderedWidth === contentWidth
      && this.lastWrappedLine !== undefined
      && this.text.startsWith(this.renderedText);
    const wrapped = canAppend ? this.appendWrappedLines(contentWidth) : undefined;
    const fullWrapped = wrapped ?? wrapTextWithAnsi(this.text, contentWidth);
    const appendedLines = this.presentLines(fullWrapped, width);
    const lines = canAppend ? [...this.stableLines, ...appendedLines] : appendedLines;

    this.renderedText = this.text;
    this.renderedWidth = contentWidth;
    this.stableLines = canAppend
      ? [...this.stableLines, ...appendedLines.slice(0, -1)]
      : appendedLines.slice(0, -1);
    this.lastWrappedLine = fullWrapped.at(-1);
    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private appendWrappedLines(contentWidth: number): string[] {
    const previousLastLine = this.lastWrappedLine?.trimEnd() ?? "";
    const trailingWhitespace = /\s*$/u.exec(this.renderedText)?.[0] ?? "";
    const delta = this.text.slice(this.renderedText.length);
    return wrapTextWithAnsi(`${previousLastLine}${trailingWhitespace}${delta}`, contentWidth);
  }

  private presentLines(lines: string[], width: number): string[] {
    const margin = " ".repeat(this.paddingX);
    return lines.map((line) => {
      const withMargins = `${margin}${line}${margin}`;
      return `${withMargins}${" ".repeat(Math.max(0, width - visibleWidth(withMargins)))}`;
    });
  }

  private resetWrapping(): void {
    this.renderedText = "";
    this.renderedWidth = undefined;
    this.stableLines = [];
    this.lastWrappedLine = undefined;
  }
}

class StreamingInlineMarkdown implements Component {
  private readonly optimized: StreamingPlainText;
  private readonly fallback: Markdown;
  private readonly styledPrefix: string;
  private readonly validatedWidths = new Set<number>();
  private readonly rejectedWidths = new Set<number>();
  private rawText: string;
  private tail: string;

  constructor(
    private readonly prefix: string,
    tail: string,
    private readonly paddingX: number,
    theme: ZCodeTheme
  ) {
    this.tail = tail;
    this.rawText = `${prefix}${tail}`;
    const prefixWidth = Math.max(8, prefix.length * 4 + 8);
    const renderedPrefix = new Markdown(prefix, 0, 0, theme.markdown).render(prefixWidth);
    this.styledPrefix = renderedPrefix.length === 1
      ? renderedPrefix[0]!.trimEnd()
      : prefix;
    this.optimized = new StreamingPlainText(`${this.styledPrefix}${tail}`, paddingX);
    this.fallback = new Markdown(this.rawText, paddingX, 0, theme.markdown);
  }

  tryAppend(text: string): boolean {
    if (!text.startsWith(this.rawText)) return false;
    const delta = text.slice(this.rawText.length);
    if (!delta) return true;
    const boundary = `${this.tail.slice(-64)}${delta}`;
    if (boundary.includes("\n") || boundary.includes("\t")
      || inlineMarkdownSyntax.test(boundary)
      || markdownAutolinkSyntax.test(boundary)) {
      return false;
    }
    this.rawText = text;
    this.tail += delta;
    this.optimized.setText(`${this.styledPrefix}${this.tail}`);
    this.fallback.setText(text);
    return true;
  }

  invalidate(): void {
    this.optimized.invalidate();
    this.fallback.invalidate();
    this.validatedWidths.clear();
    this.rejectedWidths.clear();
  }

  render(width: number): string[] {
    if (this.rejectedWidths.has(width)) return this.fallback.render(width);
    const optimized = this.optimized.render(width);
    if (this.validatedWidths.has(width)) return optimized;
    const expected = this.fallback.render(width);
    if (!sameRenderedLines(optimized, expected)) {
      this.rejectedWidths.add(width);
      return expected;
    }
    this.validatedWidths.add(width);
    return optimized;
  }

}

interface StableLineWidthState {
  characters: number;
  lineSources: string[];
  presentedLines: string[][];
  width: number;
}

interface StableMarkdownLineWidthState {
  characters: number;
  lineCharacterTotals: number[];
  rowEnds: number[];
  rows: string[];
  sources: string[];
  width: number;
}

function renderStableMarkdownLines(
  sources: string[],
  width: number,
  previous: StableMarkdownLineWidthState | undefined,
  unstableTailLines: number,
  renderLine: (source: string, index: number) => string[] | undefined,
  separatorRow?: string
): StableMarkdownLineWidthState | undefined {
  const maximumStableLines = previous
    ? Math.max(0, Math.min(previous.sources.length, sources.length) - unstableTailLines)
    : 0;
  let stableLines = 0;
  while (stableLines < maximumStableLines
    && previous?.sources[stableLines] === sources[stableLines]) {
    stableLines += 1;
  }
  const stableRows = stableLines > 0 ? previous!.rowEnds[stableLines - 1]! : 0;
  const rows = previous?.rows.slice(0, stableRows) ?? [];
  const rowEnds = previous?.rowEnds.slice(0, stableLines) ?? [];
  const lineCharacterTotals = previous?.lineCharacterTotals.slice(0, stableLines) ?? [];
  let characters = lineCharacterTotals.at(-1) ?? 0;

  for (let index = stableLines; index < sources.length; index += 1) {
    const presented = renderLine(sources[index]!, index);
    if (!presented) return undefined;
    if (separatorRow !== undefined && index > 0) {
      characters += separatorRow.length;
      if (characters > maxStreamingPresentationCharacters) return undefined;
      rows.push(separatorRow);
    }
    characters += presented.reduce((total, row) => total + row.length, 0);
    if (characters > maxStreamingPresentationCharacters) return undefined;
    rows.push(...presented);
    rowEnds.push(rows.length);
    lineCharacterTotals.push(characters);
  }

  return {
    characters,
    lineCharacterTotals,
    rowEnds,
    rows,
    sources: [...sources],
    width
  };
}

function presentPaddedLines(
  line: string,
  contentWidth: number,
  width: number,
  paddingX: number
): string[] {
  const margin = " ".repeat(paddingX);
  return wrapTextWithAnsi(line, contentWidth).map((wrapped) => {
    const withMargins = `${margin}${wrapped}${margin}`;
    return `${withMargins}${" ".repeat(Math.max(0, width - visibleWidth(withMargins)))}`;
  });
}

function quoteStyleEnvelope(theme: ZCodeTheme): { prefix: string; suffix: string } {
  const sentinel = "\u0000";
  const styled = theme.markdown.quote(theme.markdown.italic(sentinel));
  const index = styled.indexOf(sentinel);
  return index >= 0
    ? { prefix: styled.slice(0, index), suffix: styled.slice(index + sentinel.length) }
    : { prefix: "", suffix: "" };
}

function quoteContinuationPrefix(prefix: string, suffix: string): string {
  const rows = wrapTextWithAnsi(`${prefix}x\ny${suffix}`, 1_000);
  const second = rows[1] ?? "y";
  const marker = second.indexOf("y");
  return marker >= 0 ? second.slice(0, marker) : "";
}

function stitchStandaloneQuotePart(
  source: string[],
  index: number,
  total: number,
  opening: string,
  continued: string,
  suffix: string
): string[] | undefined {
  if (source.length === 0) return undefined;
  const lines = [...source];
  if (index > 0 && opening !== continued) {
    const first = lines[0]!;
    if (!first.startsWith(opening)) return undefined;
    lines[0] = `${continued}${first.slice(opening.length)}`;
  }
  if (index < total - 1 && suffix) {
    const lastIndex = lines.length - 1;
    const last = lines[lastIndex]!;
    const suffixIndex = last.lastIndexOf(suffix);
    if (suffixIndex < 0) return undefined;
    lines[lastIndex] = `${last.slice(0, suffixIndex)}${last.slice(suffixIndex + suffix.length)}`;
  }
  return lines;
}

interface QuoteStitchPrefixes {
  continued: string;
  opening: string;
}

const nestedQuoteContextProbe = "\uE000";

function quoteSourcePrefix(depth: number): string {
  return "> ".repeat(depth);
}

function renderedProbePrefix(line: string, probe: string): string | undefined {
  const index = line.indexOf(probe);
  return index >= 0 && line.indexOf(probe, index + probe.length) < 0
    ? line.slice(0, index)
    : undefined;
}

function nestedQuoteStitchPrefixes(
  theme: ZCodeTheme,
  paddingX: number,
  width: number,
  depth = 2
): QuoteStitchPrefixes | undefined {
  const firstProbe = "x";
  const secondProbe = "y";
  const sourcePrefix = quoteSourcePrefix(depth);
  const rows = new Markdown(
    `${sourcePrefix}${firstProbe}\n${sourcePrefix}${secondProbe}`,
    paddingX,
    0,
    theme.markdown
  ).render(width);
  if (rows.length !== 2) return undefined;
  const opening = renderedProbePrefix(rows[0]!, firstProbe);
  const continued = renderedProbePrefix(rows[1]!, secondProbe);
  return opening !== undefined && continued !== undefined
    ? { continued, opening }
    : undefined;
}

function renderNestedMarkdownParts(
  parts: string[],
  width: number,
  previous: StableMarkdownLineWidthState | undefined,
  paddingX: number,
  theme: ZCodeTheme,
  prefixes: QuoteStitchPrefixes,
  quoteDepth: number,
  sourceForPart: (part: string) => string
): StableMarkdownLineWidthState | undefined {
  return renderStableMarkdownLines(
    parts,
    width,
    previous,
    1,
    (part, index) => {
      const contextual = index < parts.length - 1;
      const source = sourceForPart(part);
      const renderedSource = contextual
        ? `${source}\n${quoteSourcePrefix(quoteDepth)}${nestedQuoteContextProbe}`
        : source;
      const rows = new Markdown(renderedSource, paddingX, 0, theme.markdown).render(width);
      if (contextual) {
        const probeRows = rows.filter((row) => row.includes(nestedQuoteContextProbe));
        if (probeRows.length !== 1 || !rows.at(-1)?.includes(nestedQuoteContextProbe)) {
          return undefined;
        }
        rows.pop();
      }
      return stitchStandaloneQuotePart(
        rows,
        index,
        parts.length,
        prefixes.opening,
        prefixes.continued,
        ""
      );
    }
  );
}

interface TableNaturalState {
  headerSource: string;
  headerWidths: number[];
  probeCells: string[];
  rowSources: string[];
  rowWidths: number[][];
}

interface TableSkeleton {
  bottom: string;
  headerRows: string[];
  separator: string;
  top: string;
}

interface StableTableWidthState extends TableSkeleton {
  characters: number;
  presentedRows: string[][];
  probeCells: string[];
  rowSources: string[];
  rows: string[];
  width: number;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function tableSeparatorIndices(rows: string[]): number[] {
  const indices: number[] = [];
  for (const [index, row] of rows.entries()) {
    const trimmed = row.trim();
    if (trimmed.startsWith("├") && trimmed.endsWith("┤")) indices.push(index);
  }
  return indices;
}

function tableNaturalColumnWidths(
  table: StrictStreamingTable,
  row: StrictStreamingTableRow | undefined,
  paddingX: number,
  theme: ZCodeTheme
): number[] | undefined {
  const source = [table.header.source, table.delimiter, row?.source]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  const probeWidth = Math.min(
    maxStreamingTableProbeWidth,
    Math.max(80, visibleWidth(source) + paddingX * 2 + 64)
  );
  const rendered = new Markdown(source, paddingX, 0, theme.markdown).render(probeWidth);
  if (rendered.length !== (row ? 5 : 4)) return undefined;
  const top = rendered[0]?.trim();
  if (!top?.startsWith("┌") || !top.endsWith("┐")) return undefined;
  const columns = top.slice(1, -1).split("┬");
  if (columns.length !== table.header.cells.length) return undefined;
  const widths = columns.map((column) => visibleWidth(column) - 2);
  return widths.every((width) => width > 0) ? widths : undefined;
}

function updateTableNaturalState(
  table: StrictStreamingTable,
  previous: TableNaturalState | undefined,
  paddingX: number,
  theme: ZCodeTheme
): TableNaturalState | undefined {
  const headerWidths = previous?.headerSource === table.header.source
    ? previous.headerWidths
    : tableNaturalColumnWidths(table, undefined, paddingX, theme);
  if (!headerWidths) return undefined;

  const rowSources: string[] = [];
  const rowWidths: number[][] = [];
  for (const [index, row] of table.rows.entries()) {
    const widths = previous?.rowSources[index] === row.source
      ? previous.rowWidths[index]
      : tableNaturalColumnWidths(table, row, paddingX, theme);
    if (!widths) return undefined;
    rowSources.push(row.source);
    rowWidths.push(widths);
  }

  const maximums = [...headerWidths];
  const probeCells = [...table.header.cells];
  for (const [rowIndex, widths] of rowWidths.entries()) {
    for (const [column, width] of widths.entries()) {
      if (width <= maximums[column]!) continue;
      maximums[column] = width;
      probeCells[column] = table.rows[rowIndex]!.cells[column]!;
    }
  }
  return {
    headerSource: table.header.source,
    headerWidths,
    probeCells,
    rowSources,
    rowWidths
  };
}

function tableProbeRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function renderTableSkeleton(
  table: StrictStreamingTable,
  probeRow: string,
  width: number,
  paddingX: number,
  theme: ZCodeTheme
): TableSkeleton | undefined {
  const rendered = new Markdown(
    `${table.header.source}\n${table.delimiter}\n${probeRow}`,
    paddingX,
    0,
    theme.markdown
  ).render(width);
  const separators = tableSeparatorIndices(rendered);
  const separator = separators[0];
  if (separators.length !== 1 || separator === undefined
    || !rendered[0]?.trim().startsWith("┌")
    || !rendered.at(-1)?.trim().startsWith("└")) {
    return undefined;
  }
  return {
    bottom: rendered.at(-1)!,
    headerRows: rendered.slice(1, separator),
    separator: rendered[separator]!,
    top: rendered[0]!
  };
}

function renderTableDataRow(
  table: StrictStreamingTable,
  row: StrictStreamingTableRow,
  probeRow: string,
  width: number,
  paddingX: number,
  theme: ZCodeTheme
): string[] | undefined {
  const rendered = new Markdown(
    `${table.header.source}\n${table.delimiter}\n${row.source}\n${probeRow}`,
    paddingX,
    0,
    theme.markdown
  ).render(width);
  const separators = tableSeparatorIndices(rendered);
  return separators.length === 2
    ? rendered.slice(separators[0]! + 1, separators[1])
    : undefined;
}

class StreamingFencedCodeMarkdown implements Component {
  private readonly fallback: Markdown;
  private highlightState?: {
    highlightedLines: string[];
    lineContexts?: string[];
    sourceLines: string[];
  };
  private readonly rejectedWidths = new Set<number>();
  private readonly validatedWidths = new Set<number>();
  private cachedLines?: string[];
  private cachedText?: string;
  private cachedWidth?: number;
  private fence: StrictStreamingFence;
  private rawText: string;
  private widthState?: StableLineWidthState;

  constructor(
    text: string,
    fence: StrictStreamingFence,
    private readonly paddingX: number,
    private readonly theme: ZCodeTheme
  ) {
    this.rawText = text;
    this.fence = fence;
    this.fallback = new Markdown(text, paddingX, 0, theme.markdown);
  }

  tryAppend(text: string): boolean {
    if (!text.startsWith(this.rawText)) return false;
    const fence = strictStreamingFence(text, this.theme.codeHighlighter.isEnabled());
    if (!fence) return false;
    if (fence.highlightMode !== this.fence.highlightMode || fence.language !== this.fence.language) {
      this.highlightState = undefined;
      this.widthState = undefined;
      this.validatedWidths.clear();
      this.rejectedWidths.clear();
    }
    this.rawText = text;
    this.fence = fence;
    this.fallback.setText(text);
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    return true;
  }

  invalidate(): void {
    this.fallback.invalidate();
    this.rejectedWidths.clear();
    this.validatedWidths.clear();
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.highlightState = undefined;
    this.widthState = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.rawText && this.cachedWidth === width) {
      return this.cachedLines;
    }
    if (this.rejectedWidths.has(width)) return this.fallback.render(width);
    const optimized = this.renderOptimized(width);
    if (!optimized) {
      this.rejectedWidths.add(width);
      return this.fallback.render(width);
    }
    if (!this.validatedWidths.has(width)) {
      const expected = this.fallback.render(width);
      if (!sameRenderedLines(optimized, expected)) {
        this.rejectedWidths.add(width);
        return expected;
      }
      this.validatedWidths.add(width);
    }
    this.cachedText = this.rawText;
    this.cachedWidth = width;
    this.cachedLines = optimized;
    return optimized;
  }

  private renderOptimized(width: number): string[] | undefined {
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const indent = this.theme.markdown.codeBlockIndent ?? "  ";
    const highlighted = this.highlightedCodeLines();
    if (!highlighted) return undefined;
    const lineSources = highlighted.map((line) => `${indent}${line}`);
    const previous = this.widthState?.width === width ? this.widthState : undefined;
    const presentedLines: string[][] = [];
    let characters = 0;

    for (const [index, line] of lineSources.entries()) {
      const presented = previous?.lineSources[index] === line
        ? previous.presentedLines[index]!
        : presentPaddedLines(line, contentWidth, width, this.paddingX);
      characters += presented.reduce((total, row) => total + row.length, 0);
      if (characters > maxStreamingPresentationCharacters) return undefined;
      presentedLines.push(presented);
    }

    this.widthState = { characters, lineSources, presentedLines, width };
    const opening = presentPaddedLines(
      this.theme.markdown.codeBlockBorder(`\`\`\`${this.fence.language}`),
      contentWidth,
      width,
      this.paddingX
    );
    const closing = presentPaddedLines(
      this.theme.markdown.codeBlockBorder("```"),
      contentWidth,
      width,
      this.paddingX
    );
    return [...opening, ...presentedLines.flat(), ...closing];
  }

  private highlightedCodeLines(): string[] | undefined {
    const highlightCode = this.theme.markdown.highlightCode;
    if (!highlightCode) return undefined;
    if (this.fence.highlightMode === "whole-source") {
      return highlightCode(this.fence.code, this.fence.language);
    }

    const previous = this.highlightState;
    const maximumStableLines = Math.min(
      previous?.sourceLines.length ?? 0,
      this.fence.codeLines.length
    );
    let stableLines = 0;
    while (stableLines < maximumStableLines
      && previous?.sourceLines[stableLines] === this.fence.codeLines[stableLines]
      && previous?.lineContexts?.[stableLines] === this.fence.lineContexts?.[stableLines]) {
      stableLines += 1;
    }
    const highlightedLines = previous?.highlightedLines.slice(0, stableLines) ?? [];
    for (let index = stableLines; index < this.fence.codeLines.length; index += 1) {
      const line = this.fence.codeLines[index]!;
      const context = this.fence.lineContexts?.[index];
      const highlighted = highlightCode(
        context ? `${context}\n${line}` : line,
        this.fence.language
      );
      if (highlighted.length !== (context ? 2 : 1)) return undefined;
      highlightedLines.push(highlighted.at(-1)!);
    }
    this.highlightState = {
      highlightedLines,
      lineContexts: this.fence.lineContexts ? [...this.fence.lineContexts] : undefined,
      sourceLines: [...this.fence.codeLines]
    };
    return highlightedLines;
  }
}

interface QuotedFenceWidthState {
  body: StableMarkdownLineWidthState;
  closing: string;
  opening: string;
  width: number;
}

class StreamingQuotedFencedCodeMarkdown implements Component {
  private readonly fallback: Markdown;
  private readonly rejectedWidths = new Set<number>();
  private readonly validatedWidths = new Set<number>();
  private cachedLines?: string[];
  private cachedText?: string;
  private cachedWidth?: number;
  private fence: StrictQuotedStreamingFence;
  private rawText: string;
  private widthState?: QuotedFenceWidthState;

  constructor(
    text: string,
    fence: StrictQuotedStreamingFence,
    private readonly paddingX: number,
    private readonly theme: ZCodeTheme
  ) {
    this.rawText = text;
    this.fence = fence;
    this.fallback = new Markdown(text, paddingX, 0, theme.markdown);
  }

  tryAppend(text: string): boolean {
    if (!text.startsWith(this.rawText)) return false;
    const fence = strictQuotedStreamingFence(text);
    if (!fence || fence.language !== this.fence.language
      || fence.opening !== this.fence.opening
      || fence.quoteDepth !== this.fence.quoteDepth) {
      return false;
    }
    this.rawText = text;
    this.fence = fence;
    this.fallback.setText(text);
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    return true;
  }

  invalidate(): void {
    this.fallback.invalidate();
    this.rejectedWidths.clear();
    this.validatedWidths.clear();
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.widthState = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.rawText && this.cachedWidth === width) {
      return this.cachedLines;
    }
    if (this.rejectedWidths.has(width)) return this.fallback.render(width);
    const optimized = this.renderOptimized(width);
    if (!optimized) {
      this.rejectedWidths.add(width);
      return this.fallback.render(width);
    }
    if (!this.validatedWidths.has(width)) {
      const expected = this.fallback.render(width);
      if (!sameRenderedLines(optimized, expected)) {
        this.rejectedWidths.add(width);
        return expected;
      }
      this.validatedWidths.add(width);
    }
    this.cachedText = this.rawText;
    this.cachedWidth = width;
    this.cachedLines = optimized;
    return optimized;
  }

  private renderOptimized(width: number): string[] | undefined {
    const previous = this.widthState?.width === width ? this.widthState : undefined;
    let opening = previous?.opening;
    let closing = previous?.closing;
    const body = renderStableMarkdownLines(
      this.fence.codeLines,
      width,
      previous?.body,
      1,
      (line, index) => {
        const sourcePrefix = "> ".repeat(this.fence.quoteDepth);
        const context = this.fence.lineContexts?.[index];
        const rows = new Markdown(
          [this.fence.opening, ...(context ? [context] : []), line]
            .map((source) => `${sourcePrefix}${source}`)
            .join("\n"),
          this.paddingX,
          0,
          this.theme.markdown
        ).render(width);
        const nextOpening = rows[0];
        const nextClosing = rows.at(-1);
        const bodyStart = context ? 2 : 1;
        if (rows.length < bodyStart + 2 || !nextOpening || !nextClosing
          || (opening !== undefined && opening !== nextOpening)
          || (closing !== undefined && closing !== nextClosing)) {
          return undefined;
        }
        opening ??= nextOpening;
        closing ??= nextClosing;
        return rows.slice(bodyStart, -1);
      }
    );
    if (!body || !opening || !closing
      || body.characters + opening.length + closing.length
        > maxStreamingPresentationCharacters) {
      return undefined;
    }
    this.widthState = { body, closing, opening, width };
    return [opening, ...body.rows, closing];
  }
}

class StreamingFlatBlockquoteMarkdown implements Component {
  private readonly fallback: Markdown;
  private readonly rejectedWidths = new Set<number>();
  private readonly validatedWidths = new Set<number>();
  private cachedLines?: string[];
  private cachedText?: string;
  private cachedWidth?: number;
  private quoteLines: string[];
  private rawText: string;
  private widthState?: StableLineWidthState;

  constructor(
    text: string,
    quoteLines: string[],
    private readonly paddingX: number,
    private readonly theme: ZCodeTheme
  ) {
    this.rawText = text;
    this.quoteLines = quoteLines;
    this.fallback = new Markdown(text, paddingX, 0, theme.markdown);
  }

  tryAppend(text: string): boolean {
    if (!text.startsWith(this.rawText)) return false;
    const quoteLines = flatPlainBlockquoteLines(text);
    if (!quoteLines) return false;
    this.rawText = text;
    this.quoteLines = quoteLines;
    this.fallback.setText(text);
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    return true;
  }

  invalidate(): void {
    this.fallback.invalidate();
    this.rejectedWidths.clear();
    this.validatedWidths.clear();
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.widthState = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.rawText && this.cachedWidth === width) {
      return this.cachedLines;
    }
    if (this.rejectedWidths.has(width)) return this.fallback.render(width);
    const optimized = this.renderOptimized(width);
    if (!optimized) {
      this.rejectedWidths.add(width);
      return this.fallback.render(width);
    }
    if (!this.validatedWidths.has(width)) {
      const expected = this.fallback.render(width);
      if (!sameRenderedLines(optimized, expected)) {
        this.rejectedWidths.add(width);
        return expected;
      }
      this.validatedWidths.add(width);
    }
    this.cachedText = this.rawText;
    this.cachedWidth = width;
    this.cachedLines = optimized;
    return optimized;
  }

  private renderOptimized(width: number): string[] | undefined {
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const quoteWidth = Math.max(1, contentWidth - 2);
    const { prefix, suffix } = quoteStyleEnvelope(this.theme);
    const continuation = quoteContinuationPrefix(prefix, suffix);
    const border = this.theme.markdown.quoteBorder("│ ");
    const previous = this.widthState?.width === width ? this.widthState : undefined;
    const lineSources: string[] = [];
    const presentedLines: string[][] = [];
    let characters = 0;

    for (const [index, content] of this.quoteLines.entries()) {
      const line = `${index === 0 ? prefix : continuation}${content}${
        index === this.quoteLines.length - 1 ? suffix : ""
      }`;
      lineSources.push(line);
      const presented = previous?.lineSources[index] === line
        ? previous.presentedLines[index]!
        : wrapTextWithAnsi(line, quoteWidth).flatMap((wrapped) =>
          presentPaddedLines(`${border}${wrapped}`, contentWidth, width, this.paddingX));
      characters += presented.reduce((total, row) => total + row.length, 0);
      if (characters > maxStreamingPresentationCharacters) return undefined;
      presentedLines.push(presented);
    }

    this.widthState = { characters, lineSources, presentedLines, width };
    return presentedLines.flat();
  }
}

class StreamingLineLocalBlockquoteMarkdown implements Component {
  private readonly fallback: Markdown;
  private readonly nestedPrefixes = new Map<number, QuoteStitchPrefixes | null>();
  private readonly rejectedWidths = new Set<number>();
  private readonly validatedWidths = new Set<number>();
  private cachedLines?: string[];
  private cachedText?: string;
  private cachedWidth?: number;
  private quoteLines: string[];
  private rawText: string;
  private widthState?: StableMarkdownLineWidthState;

  constructor(
    text: string,
    quoteLines: string[],
    private readonly paddingX: number,
    private readonly theme: ZCodeTheme,
    private readonly quoteDepth: 1 | StableNestedBlockquoteDepth = 1
  ) {
    this.rawText = text;
    this.quoteLines = quoteLines;
    this.fallback = new Markdown(text, paddingX, 0, theme.markdown);
  }

  tryAppend(text: string): boolean {
    if (!text.startsWith(this.rawText)) return false;
    const quoteLines = this.quoteDepth > 1
      ? nestedLineLocalBlockquoteLines(text, this.quoteDepth)
      : flatSemanticBlockquoteLines(text);
    if (!quoteLines) return false;
    this.rawText = text;
    this.quoteLines = quoteLines;
    this.fallback.setText(text);
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    return true;
  }

  invalidate(): void {
    this.fallback.invalidate();
    this.rejectedWidths.clear();
    this.validatedWidths.clear();
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.widthState = undefined;
    this.nestedPrefixes.clear();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.rawText && this.cachedWidth === width) {
      return this.cachedLines;
    }
    if (this.rejectedWidths.has(width)) return this.fallback.render(width);
    const optimized = this.renderOptimized(width);
    if (!optimized) {
      this.rejectedWidths.add(width);
      return this.fallback.render(width);
    }
    if (!this.validatedWidths.has(width)) {
      const expected = this.fallback.render(width);
      if (!sameRenderedLines(optimized, expected)) {
        this.rejectedWidths.add(width);
        return expected;
      }
      this.validatedWidths.add(width);
      this.fallback.invalidate();
    }
    this.cachedText = this.rawText;
    this.cachedWidth = width;
    this.cachedLines = optimized;
    return optimized;
  }

  private renderOptimized(width: number): string[] | undefined {
    if (this.quoteDepth > 1) return this.renderNestedOptimized(width);
    const { prefix, suffix } = quoteStyleEnvelope(this.theme);
    const continuation = quoteContinuationPrefix(prefix, suffix);
    const border = this.theme.markdown.quoteBorder("│ ");
    const margin = " ".repeat(this.paddingX);
    const opening = `${margin}${border}${prefix}`;
    const continued = `${margin}${border}${continuation}`;
    const previous = this.widthState?.width === width ? this.widthState : undefined;
    const state = renderStableMarkdownLines(
      this.quoteLines,
      width,
      previous,
      1,
      (content, index) => stitchStandaloneQuotePart(
        new Markdown(`> ${content}`, this.paddingX, 0, this.theme.markdown).render(width),
        index,
        this.quoteLines.length,
        opening,
        continued,
        suffix
      )
    );
    this.widthState = state;
    return state?.rows;
  }

  private renderNestedOptimized(width: number): string[] | undefined {
    let prefixes = this.nestedPrefixes.get(width);
    if (prefixes === undefined) {
      prefixes = nestedQuoteStitchPrefixes(
        this.theme,
        this.paddingX,
        width,
        this.quoteDepth
      ) ?? null;
      this.nestedPrefixes.set(width, prefixes);
    }
    if (!prefixes) return undefined;
    const previous = this.widthState?.width === width ? this.widthState : undefined;
    const state = renderNestedMarkdownParts(
      this.quoteLines,
      width,
      previous,
      this.paddingX,
      this.theme,
      prefixes,
      this.quoteDepth,
      (content) => `${quoteSourcePrefix(this.quoteDepth)}${content}`
    );
    this.widthState = state;
    return state?.rows;
  }
}

class StreamingCrossLineBlockquoteMarkdown implements Component {
  private readonly fallback: Markdown;
  private readonly nestedPrefixes = new Map<number, QuoteStitchPrefixes | null>();
  private readonly rejectedWidths = new Set<number>();
  private readonly validatedWidths = new Set<number>();
  private cachedLines?: string[];
  private cachedText?: string;
  private cachedWidth?: number;
  private chunks: string[];
  private rawText: string;
  private widthState?: StableMarkdownLineWidthState;

  constructor(
    text: string,
    chunks: string[],
    private readonly paddingX: number,
    private readonly theme: ZCodeTheme,
    private readonly quoteDepth: CrossLineBlockquoteDepth = 1
  ) {
    this.rawText = text;
    this.chunks = chunks;
    this.fallback = new Markdown(text, paddingX, 0, theme.markdown);
  }

  tryAppend(text: string): boolean {
    if (!text.startsWith(this.rawText)) return false;
    const quote = crossLineSemanticBlockquote(text);
    if (!quote || quote.depth !== this.quoteDepth) return false;
    this.rawText = text;
    this.chunks = quote.chunks;
    this.fallback.setText(text);
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    return true;
  }

  invalidate(): void {
    this.fallback.invalidate();
    this.rejectedWidths.clear();
    this.validatedWidths.clear();
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.widthState = undefined;
    this.nestedPrefixes.clear();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.rawText && this.cachedWidth === width) {
      return this.cachedLines;
    }
    if (this.rejectedWidths.has(width)) return this.fallback.render(width);
    const state = this.quoteDepth > 1
      ? this.renderNestedOptimized(width)
      : this.renderFlatOptimized(width);
    if (!state) {
      this.rejectedWidths.add(width);
      return this.fallback.render(width);
    }
    if (!this.validatedWidths.has(width)) {
      const expected = this.fallback.render(width);
      if (!sameRenderedLines(state.rows, expected)) {
        this.rejectedWidths.add(width);
        return expected;
      }
      this.validatedWidths.add(width);
      this.fallback.invalidate();
    }
    this.widthState = state;
    this.cachedText = this.rawText;
    this.cachedWidth = width;
    this.cachedLines = state.rows;
    return state.rows;
  }

  private renderFlatOptimized(width: number): StableMarkdownLineWidthState | undefined {
    const { prefix, suffix } = quoteStyleEnvelope(this.theme);
    const continuation = quoteContinuationPrefix(prefix, suffix);
    const border = this.theme.markdown.quoteBorder("│ ");
    const margin = " ".repeat(this.paddingX);
    const opening = `${margin}${border}${prefix}`;
    const continued = `${margin}${border}${continuation}`;
    const previous = this.widthState?.width === width ? this.widthState : undefined;
    const state = renderStableMarkdownLines(
      this.chunks,
      width,
      previous,
      1,
      (chunk, index) => stitchStandaloneQuotePart(
        new Markdown(chunk, this.paddingX, 0, this.theme.markdown).render(width),
        index,
        this.chunks.length,
        opening,
        continued,
        suffix
      )
    );
    return state;
  }

  private renderNestedOptimized(width: number): StableMarkdownLineWidthState | undefined {
    let prefixes = this.nestedPrefixes.get(width);
    if (prefixes === undefined) {
      prefixes = nestedQuoteStitchPrefixes(
        this.theme,
        this.paddingX,
        width,
        this.quoteDepth
      ) ?? null;
      this.nestedPrefixes.set(width, prefixes);
    }
    if (!prefixes) return undefined;
    const previous = this.widthState?.width === width ? this.widthState : undefined;
    return renderNestedMarkdownParts(
      this.chunks,
      width,
      previous,
      this.paddingX,
      this.theme,
      prefixes,
      this.quoteDepth,
      (chunk) => chunk
    );
  }
}

class StreamingStableTableMarkdown implements Component {
  private readonly fallback: Markdown;
  private readonly rejectedWidths = new Set<number>();
  private readonly validatedWidths = new Set<number>();
  private cachedLines?: string[];
  private cachedText?: string;
  private cachedWidth?: number;
  private naturalState?: TableNaturalState;
  private rawText: string;
  private table: StrictStreamingTable;
  private widthState?: StableTableWidthState;

  constructor(
    text: string,
    table: StrictStreamingTable,
    private readonly paddingX: number,
    private readonly theme: ZCodeTheme
  ) {
    this.rawText = text;
    this.table = table;
    this.fallback = new Markdown(text, paddingX, 0, theme.markdown);
  }

  tryAppend(text: string): boolean {
    if (!text.startsWith(this.rawText)) return false;
    const table = strictStreamingTable(text);
    if (!table) return false;
    this.rawText = text;
    this.table = table;
    this.fallback.setText(text);
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    return true;
  }

  invalidate(): void {
    this.fallback.invalidate();
    this.rejectedWidths.clear();
    this.validatedWidths.clear();
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.naturalState = undefined;
    this.widthState = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.rawText && this.cachedWidth === width) {
      return this.cachedLines;
    }
    if (this.rejectedWidths.has(width)) return this.fallback.render(width);
    const natural = updateTableNaturalState(
      this.table,
      this.naturalState,
      this.paddingX,
      this.theme
    );
    const optimized = natural ? this.renderOptimized(width, natural) : undefined;
    if (!optimized) {
      this.rejectedWidths.add(width);
      return this.fallback.render(width);
    }
    if (!this.validatedWidths.has(width)) {
      const expected = this.fallback.render(width);
      if (!sameRenderedLines(optimized.rows, expected)) {
        this.rejectedWidths.add(width);
        return expected;
      }
      this.validatedWidths.add(width);
      this.fallback.invalidate();
    }
    this.naturalState = natural;
    this.widthState = optimized;
    this.cachedText = this.rawText;
    this.cachedWidth = width;
    this.cachedLines = optimized.rows;
    return optimized.rows;
  }

  private renderOptimized(
    width: number,
    natural: TableNaturalState
  ): StableTableWidthState | undefined {
    const previous = this.widthState?.width === width ? this.widthState : undefined;
    const reusable = previous && sameStrings(previous.probeCells, natural.probeCells)
      ? previous
      : undefined;
    const probeRow = tableProbeRow(natural.probeCells);
    const skeleton = reusable
      ? {
          bottom: reusable.bottom,
          headerRows: reusable.headerRows,
          separator: reusable.separator,
          top: reusable.top
        }
      : renderTableSkeleton(this.table, probeRow, width, this.paddingX, this.theme);
    if (!skeleton) return undefined;

    let stableRows = 0;
    if (reusable) {
      const maximum = Math.min(reusable.rowSources.length, this.table.rows.length);
      while (stableRows < maximum
        && reusable.rowSources[stableRows] === this.table.rows[stableRows]?.source) {
        stableRows += 1;
      }
    }
    const presentedRows = reusable
      ? reusable.presentedRows.slice(0, stableRows)
      : [];
    for (let index = stableRows; index < this.table.rows.length; index += 1) {
      const presented = renderTableDataRow(
        this.table,
        this.table.rows[index]!,
        probeRow,
        width,
        this.paddingX,
        this.theme
      );
      if (!presented) return undefined;
      presentedRows.push(presented);
    }

    const rows = [skeleton.top, ...skeleton.headerRows, skeleton.separator];
    for (const [index, presented] of presentedRows.entries()) {
      rows.push(...presented);
      if (index < presentedRows.length - 1) rows.push(skeleton.separator);
    }
    rows.push(skeleton.bottom);
    const characters = rows.reduce((total, row) => total + row.length, 0);
    if (characters > maxStreamingPresentationCharacters) return undefined;
    return {
      ...skeleton,
      characters,
      presentedRows,
      probeCells: [...natural.probeCells],
      rowSources: this.table.rows.map((row) => row.source),
      rows,
      width
    };
  }
}

type StreamingListDetector = (text: string) => StreamingListSources | undefined;

const quotedBlankSeparatorProbe = "> x\n>\n> y";

class StreamingStableListMarkdown implements Component {
  private readonly fallback: Markdown;
  private readonly quotedBlankSeparators = new Map<number, string>();
  private readonly rejectedWidths = new Set<number>();
  private readonly validatedWidths = new Set<number>();
  private cachedLines?: string[];
  private cachedText?: string;
  private cachedWidth?: number;
  private itemSources: string[];
  private rawText: string;
  private separatorKind: StreamingListSeparatorKind;
  private widthState?: StableMarkdownLineWidthState;

  constructor(
    text: string,
    listSources: StreamingListSources,
    private readonly paddingX: number,
    private readonly theme: ZCodeTheme,
    private readonly detector: StreamingListDetector
  ) {
    this.rawText = text;
    this.itemSources = listSources.sources;
    this.separatorKind = listSources.separatorKind;
    this.fallback = new Markdown(text, paddingX, 0, theme.markdown);
  }

  tryAppend(text: string): boolean {
    if (!text.startsWith(this.rawText)) return false;
    const listSources = this.detector(text);
    if (!listSources) return false;
    if (listSources.separatorKind !== this.separatorKind) {
      this.widthState = undefined;
      this.quotedBlankSeparators.clear();
      this.validatedWidths.clear();
      this.rejectedWidths.clear();
    }
    this.rawText = text;
    this.itemSources = listSources.sources;
    this.separatorKind = listSources.separatorKind;
    this.fallback.setText(text);
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    return true;
  }

  invalidate(): void {
    this.fallback.invalidate();
    this.quotedBlankSeparators.clear();
    this.rejectedWidths.clear();
    this.validatedWidths.clear();
    this.cachedLines = undefined;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.widthState = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.rawText && this.cachedWidth === width) {
      return this.cachedLines;
    }
    if (this.rejectedWidths.has(width)) return this.fallback.render(width);
    const separatorRow = this.separatorRow(width);
    if (this.separatorKind !== "none" && separatorRow === undefined) {
      this.rejectedWidths.add(width);
      return this.fallback.render(width);
    }
    const previous = this.widthState?.width === width ? this.widthState : undefined;
    const state = renderStableMarkdownLines(
      this.itemSources,
      width,
      previous,
      0,
      (line) => new Markdown(line, this.paddingX, 0, this.theme.markdown).render(width),
      separatorRow
    );
    if (!state) {
      this.rejectedWidths.add(width);
      return this.fallback.render(width);
    }
    if (!this.validatedWidths.has(width)) {
      const expected = this.fallback.render(width);
      if (!sameRenderedLines(state.rows, expected)) {
        this.rejectedWidths.add(width);
        return expected;
      }
      this.validatedWidths.add(width);
      this.fallback.invalidate();
    }
    this.widthState = state;
    this.cachedText = this.rawText;
    this.cachedWidth = width;
    this.cachedLines = state.rows;
    return state.rows;
  }

  private separatorRow(width: number): string | undefined {
    if (this.separatorKind === "none") return undefined;
    if (this.separatorKind === "blank") {
      return " ".repeat(Math.max(0, Math.floor(width)));
    }
    const cached = this.quotedBlankSeparators.get(width);
    if (cached !== undefined) return cached;
    const rows = new Markdown(
      quotedBlankSeparatorProbe,
      this.paddingX,
      0,
      this.theme.markdown
    ).render(width);
    const firstProbeRows = rows.filter((row) => row.includes("x"));
    const secondProbeRows = rows.filter((row) => row.includes("y"));
    if (rows.length !== 3
      || firstProbeRows.length !== 1
      || secondProbeRows.length !== 1
      || rows[0] !== firstProbeRows[0]
      || rows[2] !== secondProbeRows[0]
      || rows[1]!.includes("x")
      || rows[1]!.includes("y")) {
      return undefined;
    }
    const separator = rows[1]!;
    this.quotedBlankSeparators.set(width, separator);
    return separator;
  }
}

export function normalizeMermaidTerminalWidth(source: string): string {
  let normalized = "";
  // beautiful-mermaid lays out its ASCII canvas with UTF-16 string length,
  // while terminals render CJK characters as two columns. Add zero-width code
  // units during layout so both coordinate systems agree, then remove them from
  // the rendered output below.
  for (const character of source.normalize("NFC")) {
    normalized += character;
    const missingColumns = visibleWidth(character) - character.length;
    if (missingColumns > 0) normalized += terminalWidthPlaceholder.repeat(missingColumns);
  }
  return normalized;
}

function openingFence(line: string): { marker: "`" | "~"; length: number; language: string } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s{]+)?[^\n]*$/u.exec(line);
  if (!match?.[1]) return undefined;
  return {
    marker: match[1][0] as "`" | "~",
    length: match[1].length,
    language: (match[2] ?? "").toLowerCase()
  };
}

function closesFence(line: string, marker: "`" | "~", length: number): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line);
  return match?.[1]?.[0] === marker && match[1].length >= length;
}

function trimBoundaryBlankLines(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start += 1;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

function startsContextualMarkdownBlock(line: string): boolean {
  return /^(?:[ \t]| {0,3}(?:>|[-+*](?:\s|$)|\d+[.)](?:\s|$)))/u.test(line);
}

export function splitMarkdownSegments(text: string): MarkdownSegment[] {
  const lines = text.split("\n");
  const segments: MarkdownSegment[] = [];
  let markdownStart = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const fence = openingFence(lines[index] ?? "");
    if (!fence) continue;

    let closingIndex = index + 1;
    while (closingIndex < lines.length && !closesFence(lines[closingIndex] ?? "", fence.marker, fence.length)) {
      closingIndex += 1;
    }
    // Keep a streaming or malformed block in the regular Markdown renderer until
    // its closing fence arrives. This prevents diagram layout from flickering.
    if (closingIndex >= lines.length) break;

    // Mermaid-looking text inside another fenced code block is still source.
    if (fence.language !== "mermaid") {
      index = closingIndex;
      continue;
    }

    const markdown = trimBoundaryBlankLines(lines.slice(markdownStart, index).join("\n"));
    if (markdown) segments.push({ kind: "markdown", text: markdown });
    segments.push({
      kind: "mermaid",
      source: lines.slice(index + 1, closingIndex).join("\n").trim()
    });
    markdownStart = closingIndex + 1;
    index = closingIndex;
  }

  const markdown = trimBoundaryBlankLines(lines.slice(markdownStart).join("\n"));
  if (markdown) segments.push({ kind: "markdown", text: markdown });
  return segments;
}

function splitMarkdownBlocks(text: string): string[] {
  if (!text) return [];
  const firstLine = text.split("\n", 1)[0];
  if (firstLine && startsContextualMarkdownBlock(firstLine)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: ReturnType<typeof openingFence>;

  const append = (end: number): void => {
    const block = trimBoundaryBlankLines(lines.slice(start, end).join("\n"));
    if (block) blocks.push(block);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fence) {
      if (closesFence(line, fence.marker, fence.length)) fence = undefined;
      continue;
    }
    const nextFence = openingFence(line);
    if (nextFence) {
      fence = nextFence;
      continue;
    }
    if (line.trim() !== "") continue;
    const current = trimBoundaryBlankLines(lines.slice(start, index).join("\n"));
    const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== "");
    const first = current.split("\n", 1)[0];
    if (!first || !next
      || startsContextualMarkdownBlock(first)
      || startsContextualMarkdownBlock(next)) {
      continue;
    }
    append(index);
    start = index + 1;
  }
  append(lines.length);
  return blocks;
}

export function splitStreamingMarkdownSegments(text: string): MarkdownSegment[] {
  return splitMarkdownSegments(text).flatMap((segment): MarkdownSegment[] => segment.kind === "mermaid"
    ? [segment]
    : splitMarkdownBlocks(segment.text).map((block) => ({ kind: "markdown", text: block })));
}

function diagramType(source: string): string {
  const header = source.trim().split("\n", 1)[0]?.trim().toLowerCase() ?? "";
  if (/^sequenceDiagram\b/iu.test(header)) return "sequence";
  if (/^classDiagram\b/iu.test(header)) return "class";
  if (/^erDiagram\b/iu.test(header)) return "ER";
  if (/^xychart(?:-beta)?\b/iu.test(header)) return "XY";
  if (/^stateDiagram(?:-v2)?\b/iu.test(header)) return "state";
  return "flowchart";
}

function trimDiagramLines(value: string): string[] {
  const lines = value
    .replaceAll(terminalWidthPlaceholder, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

export function renderMermaidPreview(source: string, width: number): { lines?: string[]; reason?: string } {
  if (!source) return { reason: "empty diagram" };
  if (source.length > maxMermaidSourceCharacters) return { reason: "diagram source is too large" };
  if (width < 20) return { reason: "terminal is too narrow" };

  try {
    const layoutSource = normalizeMermaidTerminalWidth(source);
    const spacious = trimDiagramLines(renderMermaidASCII(layoutSource, {
      boxBorderPadding: 1,
      colorMode: "none",
      paddingX: width >= 100 ? 3 : 2,
      paddingY: 2
    }));
    if (spacious.length > 0 && spacious.every((line) => visibleWidth(line) <= width)) {
      return { lines: spacious };
    }

    const compact = trimDiagramLines(renderMermaidASCII(layoutSource, {
      boxBorderPadding: 0,
      colorMode: "none",
      paddingX: 1,
      paddingY: 1
    }));
    return compact.length > 0 && compact.every((line) => visibleWidth(line) <= width)
      ? { lines: compact }
      : { reason: "too wide for terminal" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reason: truncateGraphemes(message.split("\n", 1)[0] ?? "", 120) || "invalid Mermaid syntax" };
  }
}

class MermaidBlock implements Component {
  constructor(
    private readonly source: string,
    private readonly paddingX: number,
    private readonly theme: ZCodeTheme
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const indent = " ".repeat(this.paddingX);
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const preview = renderMermaidPreview(this.source, contentWidth);
    const title = `${this.theme.accent("◇ Mermaid")} ${this.theme.muted(`· ${diagramType(this.source)}`)}`;

    if (preview.lines) {
      return [
        truncateToWidth(`${indent}${title}`, width),
        ...preview.lines.map((line) => truncateToWidth(`${indent}${line}`, width))
      ];
    }

    const reason = this.theme.muted(preview.reason ?? "preview unavailable");
    const source = new Markdown(
      `\`\`\`mermaid\n${this.source}\n\`\`\``,
      this.paddingX,
      0,
      this.theme.markdown
    );
    return [
      truncateToWidth(`${indent}${title}`, width),
      truncateToWidth(`${indent}${reason}`, width),
      ...source.render(width)
    ];
  }
}

export class RichMarkdown implements Component {
  private cachedText?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private renderedSegments: RenderedMarkdownSegment[] = [];
  private windowLayout?: MarkdownWindowLayout;
  private readonly streamSanitizer = new StreamingTerminalTextSanitizer();

  constructor(
    private text: string,
    private readonly paddingX: number,
    private readonly theme: ZCodeTheme
  ) {
    this.text = sanitizeTerminalText(text, { preserveSgr: false });
  }

  setText(text: string): void {
    const sanitized = sanitizeTerminalText(text, { preserveSgr: false });
    this.streamSanitizer.reset();
    if (sanitized === this.text) return;
    this.text = sanitized;
    this.invalidateTextLayout();
  }

  appendText(delta: string): void {
    const sanitized = this.streamSanitizer.append(delta);
    if (!sanitized) return;
    this.text += sanitized;
    this.invalidateTextLayout();
  }

  finishText(): void {
    const sanitized = this.streamSanitizer.finish();
    if (!sanitized) return;
    this.text += sanitized;
    this.invalidateTextLayout();
  }

  invalidate(): void {
    this.invalidateTextLayout();
    for (const rendered of this.renderedSegments) rendered.component.invalidate();
  }

  private invalidateTextLayout(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.windowLayout = undefined;
  }

  getSearchText(): string {
    return this.text;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines;
    }

    this.syncRenderedSegments();

    const lines: string[] = [];
    const blankLine = " ".repeat(Math.max(0, Math.floor(width)));
    for (const { component } of this.renderedSegments) {
      const rendered = component.render(width);
      if (rendered.length === 0) continue;
      if (lines.length > 0 && lines.at(-1)?.trim() !== "") lines.push(blankLine);
      lines.push(...rendered);
    }

    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  renderWindow(width: number, start: number, count: number): WindowedRenderResult {
    const layout = this.measureWindowLayout(width);
    const first = Math.max(0, Math.floor(start));
    const size = Math.max(0, Math.floor(count));
    const end = Math.min(layout.totalLines, first + size);
    if (size === 0 || first >= end) return { lines: [], totalLines: layout.totalLines };

    const lines: string[] = [];
    for (const part of layout.parts) {
      const partEnd = part.start + part.lineCount;
      if (partEnd <= first || part.start >= end) continue;
      const localStart = Math.max(0, first - part.start);
      const localEnd = Math.min(part.lineCount, end - part.start);
      if (!part.component) {
        lines.push(" ".repeat(Math.max(0, Math.floor(width))));
        continue;
      }
      const rendered = part.component.render(width);
      lines.push(...rendered.slice(localStart, localEnd));
      part.component.invalidate();
    }
    return { lines, totalLines: layout.totalLines };
  }

  private syncRenderedSegments(): void {
    const segments = splitStreamingMarkdownSegments(this.text);
    this.renderedSegments = segments.map((segment, index): RenderedMarkdownSegment => {
      const previous = this.renderedSegments[index];
      if (previous && sameSegment(previous.segment, segment)) return previous;
      const growsPreviousMarkdown = previous?.segment.kind === "markdown"
        && segment.kind === "markdown"
        && segment.text.startsWith(previous.segment.text);
      if (growsPreviousMarkdown
        && index === segments.length - 1
        && previous.component instanceof StreamingStableListMarkdown
        && previous.component.tryAppend(segment.text)) {
        return { segment, component: previous.component };
      }
      if (growsPreviousMarkdown
        && index === segments.length - 1
        && previous.component instanceof StreamingCrossLineBlockquoteMarkdown
        && previous.component.tryAppend(segment.text)) {
        return { segment, component: previous.component };
      }
      const plain = segment.kind === "markdown" && isPlainMarkdownBlock(segment.text);
      const fence = segment.kind === "markdown"
        ? strictStreamingFence(
          segment.text,
          this.theme.codeHighlighter.isEnabled(),
          growsPreviousMarkdown
            && previous?.component instanceof StreamingFencedCodeMarkdown
            ? maxStreamingStructuredLines
            : maxInitialStreamingStableChunks
        )
        : undefined;
      const quotedFence = segment.kind === "markdown" && !fence
        ? strictQuotedStreamingFence(
          segment.text,
          growsPreviousMarkdown
            && previous?.component instanceof StreamingQuotedFencedCodeMarkdown
            ? maxStreamingStructuredLines
            : maxInitialStreamingStableChunks
        )
        : undefined;
      const table = segment.kind === "markdown" && !fence && !quotedFence
        ? strictStreamingTable(
          segment.text,
          growsPreviousMarkdown
            && previous?.component instanceof StreamingStableTableMarkdown
            ? maxStreamingStructuredLines
            : maxInitialStreamingStableChunks
        )
        : undefined;
      const streamingTable = table;
      const markdownText = segment.kind === "markdown" ? segment.text : undefined;
      const blockquoteDepth = markdownText !== undefined && !table && !quotedFence
        ? boundedBlockquoteDepth(markdownText, 4)
        : undefined;
      const quote = blockquoteDepth === 1
        ? flatPlainBlockquoteLines(markdownText!)
        : undefined;
      const semanticQuote = blockquoteDepth === 1 && !quote
        ? flatSemanticBlockquoteLines(markdownText!)
        : undefined;
      const nestedQuote = blockquoteDepth !== undefined && blockquoteDepth > 1
        ? stableNestedBlockquote(
          markdownText!,
          growsPreviousMarkdown
            && previous?.component instanceof StreamingLineLocalBlockquoteMarkdown
            ? maxStreamingStructuredLines
            : maxInitialStreamingStableChunks
        )
        : undefined;
      const crossLineQuote = blockquoteDepth !== undefined && blockquoteDepth <= 3
        && !quote && !semanticQuote && !nestedQuote
        ? crossLineSemanticBlockquote(markdownText!, maxInitialStreamingStableChunks)
        : undefined;
      const quotedList = segment.kind === "markdown" && !quote && !semanticQuote && !nestedQuote
        && !crossLineQuote
        ? streamingQuotedListSources(segment.text, maxInitialStreamingStableChunks)
        : undefined;
      let list: StreamingListSources | undefined;
      let listEvaluated = false;
      if (previous?.segment.kind === "markdown" && segment.kind === "markdown"
        && index === segments.length - 1) {
        if (previous.component instanceof StreamingFencedCodeMarkdown
          && previous.component.tryAppend(segment.text)) {
          return { segment, component: previous.component };
        }
        if (previous.component instanceof StreamingQuotedFencedCodeMarkdown
          && previous.component.tryAppend(segment.text)) {
          return { segment, component: previous.component };
        }
        if (previous.component instanceof StreamingStableTableMarkdown
          && previous.component.tryAppend(segment.text)) {
          return { segment, component: previous.component };
        }
        if (previous.component instanceof StreamingFlatBlockquoteMarkdown
          && previous.component.tryAppend(segment.text)) {
          return { segment, component: previous.component };
        }
        if (previous.component instanceof StreamingLineLocalBlockquoteMarkdown
          && previous.component.tryAppend(segment.text)) {
          return { segment, component: previous.component };
        }
        if (previous.component instanceof StreamingInlineMarkdown
          && previous.component.tryAppend(segment.text)) {
          return { segment, component: previous.component };
        }
        if (previous.component instanceof StreamingPlainText && plain) {
          previous.component.setText(segment.text);
          return { segment, component: previous.component };
        }
        const inline = plain ? undefined : stableInlineMarkdown(segment.text);
        list = streamingRootListSources(
          segment.text,
          growsPreviousMarkdown
            && previous.component instanceof StreamingStableListMarkdown
            ? maxStreamingStructuredLines
            : maxInitialStreamingStableChunks
        );
        listEvaluated = true;
        if (previous.component instanceof Markdown
          && !plain && !inline && !list && !fence && !quotedFence && !streamingTable
          && !quote && !semanticQuote
          && !nestedQuote && !crossLineQuote
          && !quotedList) {
          previous.component.setText(segment.text);
          return { segment, component: previous.component };
        }
      }
      if (!listEvaluated && segment.kind === "markdown") {
        list = streamingRootListSources(segment.text, maxInitialStreamingStableChunks);
      }
      const inline = segment.kind === "markdown" && !plain
        ? stableInlineMarkdown(segment.text)
        : undefined;
      return {
        segment,
        component: segment.kind === "mermaid"
          ? new MermaidBlock(segment.source, this.paddingX, this.theme)
          : plain
            ? new StreamingPlainText(segment.text, this.paddingX)
            : fence
              ? new StreamingFencedCodeMarkdown(
                segment.text,
                fence,
                this.paddingX,
                this.theme
              )
              : quotedFence
                ? new StreamingQuotedFencedCodeMarkdown(
                  segment.text,
                  quotedFence,
                  this.paddingX,
                  this.theme
                )
                : streamingTable
                  ? new StreamingStableTableMarkdown(
                  segment.text,
                  streamingTable,
                  this.paddingX,
                  this.theme
                )
                : quote
                  ? new StreamingFlatBlockquoteMarkdown(
                    segment.text,
                    quote,
                    this.paddingX,
                    this.theme
                  )
                  : semanticQuote
                    ? new StreamingLineLocalBlockquoteMarkdown(
                      segment.text,
                      semanticQuote,
                      this.paddingX,
                      this.theme
                    )
                    : nestedQuote
                      ? new StreamingLineLocalBlockquoteMarkdown(
                        segment.text,
                        nestedQuote.lines,
                        this.paddingX,
                        this.theme,
                        nestedQuote.depth
                      )
                      : crossLineQuote
                        ? new StreamingCrossLineBlockquoteMarkdown(
                          segment.text,
                          crossLineQuote.chunks,
                          this.paddingX,
                          this.theme,
                          crossLineQuote.depth
                        )
                          : quotedList
                            ? new StreamingStableListMarkdown(
                              segment.text,
                              quotedList,
                              this.paddingX,
                              this.theme,
                              streamingQuotedListSources
                            )
                            : inline
                              ? new StreamingInlineMarkdown(
                            inline.prefix,
                            inline.tail,
                            this.paddingX,
                            this.theme
                          )
                          : list
                            ? new StreamingStableListMarkdown(
                              segment.text,
                              list,
                              this.paddingX,
                              this.theme,
                              streamingRootListSources
                            )
                            : new Markdown(segment.text, this.paddingX, 0, this.theme.markdown)
      };
    });
  }

  private measureWindowLayout(width: number): MarkdownWindowLayout {
    if (this.windowLayout?.text === this.text && this.windowLayout.width === width) {
      return this.windowLayout;
    }
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.syncRenderedSegments();
    const parts: MarkdownWindowPart[] = [];
    let totalLines = 0;
    let previousLastLine: string | undefined;
    for (const segment of this.renderedSegments) {
      let firstChunk = true;
      for (const component of this.windowComponents(segment)) {
        const rendered = component.render(width);
        if (rendered.length === 0) continue;
        if (firstChunk && totalLines > 0 && previousLastLine?.trim() !== "") {
          parts.push({ lineCount: 1, start: totalLines });
          totalLines += 1;
        }
        parts.push({ component, lineCount: rendered.length, start: totalLines });
        totalLines += rendered.length;
        previousLastLine = rendered.at(-1);
        component.invalidate();
        firstChunk = false;
      }
    }
    this.windowLayout = { parts, text: this.text, totalLines, width };
    return this.windowLayout;
  }

  private windowComponents(rendered: RenderedMarkdownSegment): Component[] {
    if (rendered.segment.kind !== "markdown") return [rendered.component];
    const lines = rendered.segment.text.split("\n");
    if (rendered.component instanceof StreamingQuotedFencedCodeMarkdown
      || lines.length <= markdownWindowChunkLines
      || lines.some((line) => openingFence(line) || /^\s*\|.*\|\s*$/u.test(line))) {
      return [rendered.component];
    }
    const components: Component[] = [];
    for (let start = 0; start < lines.length; start += markdownWindowChunkLines) {
      components.push(new Markdown(
        lines.slice(start, start + markdownWindowChunkLines).join("\n"),
        this.paddingX,
        0,
        this.theme.markdown
      ));
    }
    return components;
  }
}

function sameSegment(left: MarkdownSegment, right: MarkdownSegment): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "markdown"
    ? left.text === (right as Extract<MarkdownSegment, { kind: "markdown" }>).text
    : left.source === (right as Extract<MarkdownSegment, { kind: "mermaid" }>).source;
}
