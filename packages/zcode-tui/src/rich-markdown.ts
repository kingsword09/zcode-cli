import { renderMermaidASCII } from "beautiful-mermaid";
import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  type Component
} from "@earendil-works/pi-tui";

import type { ZCodeTheme } from "./theme.ts";
import { sanitizeTerminalText, truncateGraphemes } from "./terminal-text.ts";
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

    const markdown = lines.slice(markdownStart, index).join("\n").trim();
    if (markdown) segments.push({ kind: "markdown", text: markdown });
    segments.push({
      kind: "mermaid",
      source: lines.slice(index + 1, closingIndex).join("\n").trim()
    });
    markdownStart = closingIndex + 1;
    index = closingIndex;
  }

  const markdown = lines.slice(markdownStart).join("\n").trim();
  if (markdown) segments.push({ kind: "markdown", text: markdown });
  return segments;
}

function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: ReturnType<typeof openingFence>;

  const append = (end: number): void => {
    const block = lines.slice(start, end).join("\n").trim();
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

  constructor(
    private text: string,
    private readonly paddingX: number,
    private readonly theme: ZCodeTheme
  ) {
    this.text = sanitizeTerminalText(text, { preserveSgr: false });
  }

  setText(text: string): void {
    const sanitized = sanitizeTerminalText(text, { preserveSgr: false });
    if (sanitized === this.text) return;
    this.text = sanitized;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.windowLayout = undefined;
    for (const rendered of this.renderedSegments) rendered.component.invalidate();
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
    for (const { component } of this.renderedSegments) {
      const rendered = component.render(width);
      if (rendered.length === 0) continue;
      if (lines.length > 0 && lines.at(-1)?.trim() !== "") lines.push("");
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
        lines.push("");
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
      if (previous?.segment.kind === "markdown" && segment.kind === "markdown"
        && index === segments.length - 1 && previous.component instanceof Markdown) {
        previous.component.setText(segment.text);
        return { segment, component: previous.component };
      }
      return {
        segment,
        component: segment.kind === "mermaid"
          ? new MermaidBlock(segment.source, this.paddingX, this.theme)
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
    if (lines.length <= markdownWindowChunkLines
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
