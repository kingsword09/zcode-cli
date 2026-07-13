import { renderMermaidASCII } from "beautiful-mermaid";
import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  type Component
} from "@earendil-works/pi-tui";

import type { ZCodeTheme } from "./theme.ts";

export type MarkdownSegment =
  | { kind: "markdown"; text: string }
  | { kind: "mermaid"; source: string };

const maxMermaidSourceCharacters = 20_000;
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
    return { reason: message.split("\n", 1)[0]?.slice(0, 120) || "invalid Mermaid syntax" };
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

  constructor(
    private text: string,
    private readonly paddingX: number,
    private readonly theme: ZCodeTheme
  ) {}

  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    for (const segment of splitMarkdownSegments(this.text)) {
      const component: Component = segment.kind === "mermaid"
        ? new MermaidBlock(segment.source, this.paddingX, this.theme)
        : new Markdown(segment.text, this.paddingX, 0, this.theme.markdown);
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
}
