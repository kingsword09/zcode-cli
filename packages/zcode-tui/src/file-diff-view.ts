import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component
} from "@earendil-works/pi-tui";
import { diffWordsWithSpace } from "diff";

import { createTheme, type ZCodeTheme } from "./theme.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
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
  status?: "modified" | "added" | "deleted" | "renamed" | "untracked";
  oldFilePath?: string;
  isBinary?: boolean;
  isLargeFile?: boolean;
  isUntracked?: boolean;
}

export interface FileDiffViewOptions {
  toolName: string;
  state: string;
  diffs: FileDiffData[];
  expanded?: boolean;
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

function previewWriteDiff(input: Record<string, unknown>): FileDiffData[] {
  const filePath = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path);
  const content = asString(input.content);
  if (!filePath || content === undefined) return [];
  const lines = content.replace(/\r/g, "").split("\n").map((line) => `+${line}`);
  if (lines.at(-1) === "+") lines.pop();
  if (lines.length === 0) return [];
  return [{
    filePath,
    additions: lines.length,
    deletions: 0,
    structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }]
  }];
}

function previewEditDiff(input: Record<string, unknown>): FileDiffData[] {
  const filePath = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path);
  if (!filePath) return [];
  const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [input];
  const hunks: FileDiffHunk[] = [];
  for (const edit of edits) {
    const oldString = asString(edit.old_string) ?? asString(edit.oldString) ?? "";
    const newString = asString(edit.new_string) ?? asString(edit.newString) ?? "";
    if (!oldString && !newString) continue;
    const removed = oldString.replace(/\r/g, "").split("\n").map((line) => `-${line}`);
    const added = newString.replace(/\r/g, "").split("\n").map((line) => `+${line}`);
    if (removed.at(-1) === "-") removed.pop();
    if (added.at(-1) === "+") added.pop();
    hunks.push({
      oldStart: 1,
      oldLines: removed.length,
      newStart: 1,
      newLines: added.length,
      lines: [...removed, ...added]
    });
  }
  if (hunks.length === 0) return [];
  const changes = countChanges(hunks);
  return [{ filePath, ...changes, structuredPatch: hunks }];
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

export function fileDiffsForPermission(name: string, input: unknown): FileDiffData[] {
  if (!isRecord(input)) return [];
  const normalized = name.toLowerCase().replace(/[^a-z]/gu, "");
  if (normalized.includes("applypatch") || normalized === "patch") {
    const patch = asString(input.patch_text) ?? asString(input.patchText) ?? asString(input.patch);
    return patch ? parseApplyPatch(patch) : [];
  }
  if (normalized.includes("write")) return previewWriteDiff(input);
  if (normalized.includes("edit")) return previewEditDiff(input);
  return [];
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

export function wordDiffLines(
  removed: string,
  added: string,
  theme: ZCodeTheme,
  highlightFragment: (value: string) => string = (value) => value
): { removed: string; added: string } {
  const changes = diffWordsWithSpace(
    sanitizeTerminalText(removed, { preserveSgr: false }),
    sanitizeTerminalText(added, { preserveSgr: false })
  );
  return {
    removed: changes
      .filter((change) => !change.added)
      .map((change) => {
        const highlighted = highlightFragment(change.value);
        return change.removed ? theme.diffRemovedWord(highlighted) : highlighted;
      })
      .join(""),
    added: changes
      .filter((change) => !change.removed)
      .map((change) => {
        const highlighted = highlightFragment(change.value);
        return change.added ? theme.diffAddedWord(highlighted) : highlighted;
      })
      .join("")
  };
}

function changedWords(hunk: FileDiffHunk, theme: ZCodeTheme, filePath: string): Map<number, string> {
  const output = new Map<number, string>();
  for (let index = 0; index < hunk.lines.length;) {
    if (!hunk.lines[index]?.startsWith("-")) {
      index += 1;
      continue;
    }
    const removedStart = index;
    while (index < hunk.lines.length && hunk.lines[index]?.startsWith("-")) index += 1;
    const addedStart = index;
    while (index < hunk.lines.length && hunk.lines[index]?.startsWith("+")) index += 1;
    const pairCount = Math.min(addedStart - removedStart, index - addedStart);
    for (let offset = 0; offset < pairCount; offset += 1) {
      const removedIndex = removedStart + offset;
      const addedIndex = addedStart + offset;
      const pair = wordDiffLines(
        hunk.lines[removedIndex]!.slice(1),
        hunk.lines[addedIndex]!.slice(1),
        theme,
        (value) => theme.codeHighlighter.highlightFileLine(value, filePath)
      );
      output.set(removedIndex, pair.removed);
      output.set(addedIndex, pair.added);
    }
  }
  return output;
}

export class FileDiffView implements Component {
  constructor(
    private readonly theme: ZCodeTheme,
    private readonly options: FileDiffViewOptions
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const output: string[] = [];
    const diffs = this.options.expanded ? this.options.diffs : this.options.diffs.slice(0, maxVisibleFiles);
    const digits = Math.max(2, String(maximumLineNumber(diffs)).length);
    let visibleHunks = 0;
    let visibleLines = 0;
    let truncated = this.options.diffs.length > diffs.length;

    for (let fileIndex = 0; fileIndex < diffs.length; fileIndex += 1) {
      const diff = diffs[fileIndex]!;
      if (fileIndex > 0) output.push("");
      output.push(this.renderHeader(diff, fileIndex, width));

      for (const hunk of diff.structuredPatch) {
        if (!this.options.expanded && (visibleHunks >= maxVisibleHunks || visibleLines >= maxVisibleLines)) {
          truncated = true;
          break;
        }
        visibleHunks += 1;
        output.push(this.renderHunkHeader(hunk, digits, width));
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        const wordChanges = changedWords(hunk, this.theme, diff.filePath);

        for (const [lineIndex, sourceLine] of hunk.lines.entries()) {
          if (!this.options.expanded && visibleLines >= maxVisibleLines) {
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
          const renderedContent = wordChanges.get(lineIndex)
            ?? this.theme.codeHighlighter.highlightFileLine(content, diff.filePath);
          output.push(...this.renderCodeLine(marker, renderedContent, oldLabel, newLabel, digits, width));
          if (marker !== "+" && oldLine !== undefined) oldLine += 1;
          if (marker !== "-" && newLine !== undefined) newLine += 1;
        }
      }
      if (diff.structuredPatch.length === 0) {
        const description = diff.isBinary ? "Binary file"
          : diff.isLargeFile ? "Large file modified"
            : diff.isUntracked ? "Untracked file · textual preview unavailable"
              : "No textual diff available";
        output.push(this.theme.muted(`└ ${description}`));
      }
      if (diff.truncated) truncated = true;
    }

    if (truncated) output.push(this.theme.muted("… diff truncated · Ctrl+O to expand"));
    return output;
  }

  private renderHeader(diff: FileDiffData, index: number, width: number): string {
    const label = index === 0
      ? `${stateIcon(this.options.state, this.theme)} ${this.theme.bold(this.options.toolName)}`
      : this.theme.muted("↳");
    const stats = diff.additions || diff.deletions
      ? `${this.theme.success(`+${diff.additions}`)} ${this.theme.error(`-${diff.deletions}`)}`
      : this.theme.muted(diff.status ?? "no changes");
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
