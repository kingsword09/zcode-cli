import type { FileDiffData, FileDiffHunk } from "./file-diff-view.ts";

export const MAX_RETAINED_DIFF_FILES = 32;
export const MAX_RETAINED_DIFF_LINES = 2_000;
export const MAX_RETAINED_DIFF_CHARACTERS = 250_000;

const maxMetadataCharacters = 4_096;

export interface FileDiffRetentionLimits {
  characters: number;
  files: number;
  lines: number;
}

export interface FileDiffRetentionSize {
  characters: number;
  files: number;
  lines: number;
}

export const FILE_DIFF_RETENTION_LIMITS: FileDiffRetentionLimits = {
  characters: MAX_RETAINED_DIFF_CHARACTERS,
  files: MAX_RETAINED_DIFF_FILES,
  lines: MAX_RETAINED_DIFF_LINES
};

function limit(value: number): number {
  return Math.max(0, Math.floor(value));
}

function stringPrefix(value: string, maximum: number): string {
  let end = Math.min(value.length, limit(maximum));
  if (end > 0
    && end < value.length
    && /[\uD800-\uDBFF]/u.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[end]!)) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function fileDiffRetentionSize(diffs: readonly FileDiffData[]): FileDiffRetentionSize {
  let characters = 0;
  let lines = 0;
  for (const file of diffs) {
    characters += file.filePath.length + (file.oldFilePath?.length ?? 0);
    for (const hunk of file.structuredPatch) {
      characters += hunk.header?.length ?? 0;
      lines += hunk.lines.length;
      for (const line of hunk.lines) characters += line.length;
    }
  }
  return { characters, files: diffs.length, lines };
}

function fits(size: FileDiffRetentionSize, limits: FileDiffRetentionLimits): boolean {
  return size.files <= limits.files
    && size.lines <= limits.lines
    && size.characters <= limits.characters;
}

function markLastTruncated(diffs: FileDiffData[]): FileDiffData[] {
  const last = diffs.at(-1);
  if (!last || last.truncated) return diffs;
  diffs[diffs.length - 1] = { ...last, truncated: true };
  return diffs;
}

export function boundedFileDiffs(
  diffs: readonly FileDiffData[],
  requestedLimits: FileDiffRetentionLimits = FILE_DIFF_RETENTION_LIMITS
): FileDiffData[] {
  const limits = {
    characters: limit(requestedLimits.characters),
    files: limit(requestedLimits.files),
    lines: limit(requestedLimits.lines)
  };
  if (fits(fileDiffRetentionSize(diffs), limits)) return diffs as FileDiffData[];

  const retained: FileDiffData[] = [];
  let remainingCharacters = limits.characters;
  let remainingLines = limits.lines;
  let omitted = false;

  for (const file of diffs) {
    if (retained.length >= limits.files || remainingCharacters <= 0 || remainingLines <= 0) {
      omitted = true;
      break;
    }

    const filePath = stringPrefix(
      file.filePath,
      Math.min(remainingCharacters, maxMetadataCharacters)
    );
    if (!filePath && file.filePath) {
      omitted = true;
      break;
    }
    remainingCharacters -= filePath.length;
    let truncated = file.truncated === true || filePath.length < file.filePath.length;

    let oldFilePath: string | undefined;
    if (file.oldFilePath) {
      oldFilePath = stringPrefix(
        file.oldFilePath,
        Math.min(remainingCharacters, maxMetadataCharacters)
      );
      remainingCharacters -= oldFilePath.length;
      if (oldFilePath.length < file.oldFilePath.length) truncated = true;
    }

    const structuredPatch: FileDiffHunk[] = [];
    for (const hunk of file.structuredPatch) {
      if (remainingCharacters <= 0 || remainingLines <= 0) {
        truncated = true;
        omitted = true;
        break;
      }

      let header: string | undefined;
      if (hunk.header) {
        header = stringPrefix(
          hunk.header,
          Math.min(remainingCharacters, maxMetadataCharacters)
        );
        remainingCharacters -= header.length;
        if (header.length < hunk.header.length) truncated = true;
      }

      const lines: string[] = [];
      for (const sourceLine of hunk.lines) {
        if (remainingCharacters <= 0 || remainingLines <= 0) {
          truncated = true;
          omitted = true;
          break;
        }
        const line = stringPrefix(sourceLine, remainingCharacters);
        if (!line && sourceLine) {
          truncated = true;
          omitted = true;
          break;
        }
        lines.push(line);
        remainingCharacters -= line.length;
        remainingLines -= 1;
        if (line.length < sourceLine.length) {
          truncated = true;
          omitted = true;
          break;
        }
      }

      if (header !== undefined || lines.length > 0 || hunk.lines.length === 0) {
        structuredPatch.push({ ...hunk, header, lines });
      }
      if (omitted) break;
    }

    retained.push({
      ...file,
      filePath,
      oldFilePath,
      structuredPatch,
      truncated: truncated || undefined
    });
    if (omitted) break;
  }

  if (retained.length < diffs.length) omitted = true;
  return omitted ? markLastTruncated(retained) : retained;
}
