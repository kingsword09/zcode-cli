import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component
} from "@earendil-works/pi-tui";

import { createTheme, type ZCodeTheme } from "./theme.ts";
import { asString, isRecord } from "./types.ts";

const maxVisibleFiles = 8;
const maxVisibleHunks = 8;
const maxVisibleLines = 160;

export interface FileDiffHunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  header?: string;
  lines: string[];
}

export interface FileDiffData {
  filePath: string;
  additions: number;
  deletions: number;
  structuredPatch: FileDiffHunk[];
  truncated?: boolean;
}

export interface FileDiffViewOptions {
  toolName: string;
  state: string;
  diffs: FileDiffData[];
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseHunk(value: unknown): FileDiffHunk | undefined {
  if (!isRecord(value) || !Array.isArray(value.lines) || !value.lines.every((line) => typeof line === "string")) {
    return undefined;
  }
  return {
    oldStart: integer(value.oldStart),
    oldLines: integer(value.oldLines),
    newStart: integer(value.newStart),
    newLines: integer(value.newLines),
    header: asString(value.header),
    lines: value.lines
  };
}

function countChanges(hunks: FileDiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function parseDisplay(value: unknown): FileDiffData | undefined {
  if (!isRecord(value) || asString(value.kind) !== "file_diff") return undefined;
  const filePath = asString(value.filePath)?.trim();
  if (!filePath || !Array.isArray(value.structuredPatch)) return undefined;
  const hunks = value.structuredPatch.map(parseHunk).filter((hunk): hunk is FileDiffHunk => Boolean(hunk));
  if (hunks.length === 0) return undefined;
  const counted = countChanges(hunks);
  return {
    filePath,
    additions: integer(value.additions) ?? counted.additions,
    deletions: integer(value.deletions) ?? counted.deletions,
    structuredPatch: hunks,
    truncated: value.truncated === true
  };
}

function collectDisplays(value: unknown, depth = 0): FileDiffData[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectDisplays(item, depth + 1));
  if (!isRecord(value)) return [];
  const direct = parseDisplay(value);
  if (direct) return [direct];
  return [value.display, value.result, value.output, value.value]
    .flatMap((nested) => collectDisplays(nested, depth + 1));
}

interface PatchBuilder {
  filePath: string;
  operation: "add" | "update" | "delete";
  hunks: FileDiffHunk[];
  currentHeader?: string;
  currentLines: string[];
}

function parseRange(header: string): Pick<FileDiffHunk, "oldStart" | "oldLines" | "newStart" | "newLines"> {
  const match = /@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/u.exec(header);
  if (!match) return {};
  return {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? "1"),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? "1")
  };
}

function parseApplyPatch(patchText: string): FileDiffData[] {
  const files: FileDiffData[] = [];
  let builder: PatchBuilder | undefined;

  const flushHunk = (): void => {
    if (!builder || builder.currentLines.length === 0) return;
    const range = builder.currentHeader ? parseRange(builder.currentHeader) : {};
    const additions = builder.currentLines.filter((line) => line.startsWith("+")).length;
    const deletions = builder.currentLines.filter((line) => line.startsWith("-")).length;
    const context = builder.currentLines.length - additions - deletions;
    const oldStart = range.oldStart ?? (builder.operation === "add" ? 0 : builder.operation === "delete" ? 1 : undefined);
    const newStart = range.newStart ?? (builder.operation === "delete" ? 0 : builder.operation === "add" ? 1 : undefined);
    builder.hunks.push({
      ...range,
      oldStart,
      oldLines: range.oldLines ?? deletions + context,
      newStart,
      newLines: range.newLines ?? additions + context,
      header: builder.currentHeader,
      lines: builder.currentLines
    });
    builder.currentHeader = undefined;
    builder.currentLines = [];
  };

  const flushFile = (): void => {
    if (!builder) return;
    flushHunk();
    if (builder.hunks.length > 0) {
      const changes = countChanges(builder.hunks);
      files.push({
        filePath: builder.filePath,
        additions: changes.additions,
        deletions: changes.deletions,
        structuredPatch: builder.hunks
      });
    }
    builder = undefined;
  };

  for (const rawLine of patchText.replace(/\r/g, "").split("\n")) {
    const file = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/u.exec(rawLine);
    if (file?.[1] && file[2]) {
      flushFile();
      builder = {
        filePath: file[2].trim(),
        operation: file[1].toLowerCase() as PatchBuilder["operation"],
        hunks: [],
        currentLines: []
      };
      continue;
    }
    if (!builder || rawLine === "*** Begin Patch" || rawLine === "*** End Patch") continue;
    if (rawLine.startsWith("*** Move to:")) {
      builder.filePath = rawLine.slice("*** Move to:".length).trim() || builder.filePath;
      continue;
    }
    if (rawLine.startsWith("@@")) {
      flushHunk();
      builder.currentHeader = rawLine;
      continue;
    }
    if (rawLine.startsWith("***")) continue;
    if (/^[+\- ]/u.test(rawLine)) {
      builder.currentLines.push(rawLine);
    } else if (rawLine) {
      builder.currentLines.push(` ${rawLine}`);
    }
  }
  flushFile();
  return files;
}

function writeCreateDiff(input: unknown, result: unknown, state: string): FileDiffData[] {
  if (!["complete", "completed", "success"].includes(state.toLowerCase())) return [];
  if (!isRecord(input) || !isRecord(result) || result.success === false) return [];
  const filePath = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path);
  const content = asString(input.content);
  if (!filePath || content === undefined) return [];
  const sourceLines = content.replace(/\r/g, "").split("\n");
  if (sourceLines.at(-1) === "") sourceLines.pop();
  const lines = sourceLines.map((line) => `+${line}`);
  if (lines.length === 0) return [];
  return [{
    filePath,
    additions: lines.length,
    deletions: 0,
    structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }]
  }];
}

export function isFileMutationTool(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z]/gu, "");
  return normalized === "write" || normalized === "edit" || normalized === "applypatch";
}

export function fileDiffsForTool(
  name: string,
  input: unknown,
  result: unknown,
  state: string
): FileDiffData[] {
  if (!isFileMutationTool(name)) return [];
  const official = collectDisplays(result);
  if (official.length > 0) return official;
  const normalized = name.toLowerCase().replace(/[^a-z]/gu, "");
  if (normalized === "applypatch" && isRecord(input)) {
    const patch = asString(input.patch_text) ?? asString(input.patchText) ?? asString(input.patch);
    if (patch) return parseApplyPatch(patch);
  }
  return normalized === "write" ? writeCreateDiff(input, result, state) : [];
}

function stateIcon(state: string, theme: ZCodeTheme): string {
  const normalized = state.toLowerCase();
  if (["failed", "error", "cancelled"].includes(normalized)) return theme.error("✗");
  if (["complete", "completed", "success"].includes(normalized)) return theme.success("✓");
  return theme.accent("●");
}

function padded(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, "", false);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function hunkLabel(hunk: FileDiffHunk): string {
  if (hunk.header?.trim()) return hunk.header.trim();
  if (hunk.oldStart === undefined || hunk.newStart === undefined) return "@@";
  return `@@ -${hunk.oldStart},${hunk.oldLines ?? 0} +${hunk.newStart},${hunk.newLines ?? 0} @@`;
}

function maximumLineNumber(diffs: FileDiffData[]): number {
  let maximum = 1;
  for (const diff of diffs) {
    for (const hunk of diff.structuredPatch) {
      if (hunk.oldStart !== undefined) maximum = Math.max(maximum, hunk.oldStart + (hunk.oldLines ?? 0));
      if (hunk.newStart !== undefined) maximum = Math.max(maximum, hunk.newStart + (hunk.newLines ?? 0));
    }
  }
  return maximum;
}

export class FileDiffView implements Component {
  constructor(
    private readonly theme: ZCodeTheme,
    private readonly options: FileDiffViewOptions
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const output: string[] = [];
    const diffs = this.options.diffs.slice(0, maxVisibleFiles);
    const digits = Math.max(2, String(maximumLineNumber(diffs)).length);
    let visibleHunks = 0;
    let visibleLines = 0;
    let truncated = this.options.diffs.length > diffs.length;

    for (let fileIndex = 0; fileIndex < diffs.length; fileIndex += 1) {
      const diff = diffs[fileIndex]!;
      if (fileIndex > 0) output.push("");
      output.push(this.renderHeader(diff, fileIndex, width));

      for (const hunk of diff.structuredPatch) {
        if (visibleHunks >= maxVisibleHunks || visibleLines >= maxVisibleLines) {
          truncated = true;
          break;
        }
        visibleHunks += 1;
        output.push(this.renderHunkHeader(hunk, digits, width));
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;

        for (const sourceLine of hunk.lines) {
          if (visibleLines >= maxVisibleLines) {
            truncated = true;
            break;
          }
          visibleLines += 1;
          const marker = sourceLine.startsWith("+") || sourceLine.startsWith("-") || sourceLine.startsWith(" ")
            ? sourceLine[0]!
            : " ";
          const content = marker === sourceLine[0] ? sourceLine.slice(1) : sourceLine;
          const oldLabel = marker === "+" || oldLine === undefined ? "" : String(oldLine);
          const newLabel = marker === "-" || newLine === undefined ? "" : String(newLine);
          output.push(...this.renderCodeLine(marker, content, oldLabel, newLabel, digits, width));
          if (marker !== "+" && oldLine !== undefined) oldLine += 1;
          if (marker !== "-" && newLine !== undefined) newLine += 1;
        }
      }
      if (diff.truncated) truncated = true;
    }

    if (truncated) output.push(this.theme.muted("… diff truncated"));
    return output;
  }

  private renderHeader(diff: FileDiffData, index: number, width: number): string {
    const label = index === 0
      ? `${stateIcon(this.options.state, this.theme)} ${this.theme.bold(this.options.toolName)}`
      : this.theme.muted("↳");
    const stats = `${this.theme.success(`+${diff.additions}`)} ${this.theme.error(`-${diff.deletions}`)}`;
    const fixedWidth = visibleWidth(label) + visibleWidth(stats) + 2;
    const path = truncateToWidth(diff.filePath, Math.max(1, width - fixedWidth));
    return truncateToWidth(`${label} ${this.theme.bold(path)} ${stats}`, width);
  }

  private renderHunkHeader(hunk: FileDiffHunk, digits: number, width: number): string {
    const gutter = width >= 24 ? `${" ".repeat(digits)} ${" ".repeat(digits)} │ ` : "│ ";
    return this.theme.diffHunkLine(padded(`${gutter}${hunkLabel(hunk)}`, width));
  }

  private renderCodeLine(
    marker: string,
    content: string,
    oldLabel: string,
    newLabel: string,
    digits: number,
    width: number
  ): string[] {
    const wideGutter = width >= 24;
    const prefix = wideGutter
      ? `${oldLabel.padStart(digits)} ${newLabel.padStart(digits)} │${marker} `
      : `│${marker} `;
    const continuation = wideGutter
      ? `${" ".repeat(digits)} ${" ".repeat(digits)} │  `
      : "│  ";
    const contentWidth = Math.max(1, width - visibleWidth(prefix));
    const wrapped = wrapTextWithAnsi(content.replace(/\t/g, "   "), contentWidth);
    const rows = (wrapped.length > 0 ? wrapped : [""]).map((line, index) => {
      const row = padded(`${index === 0 ? prefix : continuation}${line}`, width);
      if (marker === "+") return this.theme.diffAddedLine(row);
      if (marker === "-") return this.theme.diffRemovedLine(row);
      return this.theme.muted(row);
    });
    return rows;
  }
}

export function fileDiffCard(options: FileDiffViewOptions, width = 80): string {
  return new FileDiffView(createTheme(false), options).render(width).map((line) => line.trimEnd()).join("\n");
}
