import { describe, expect, test } from "bun:test";

import {
  boundedFileDiffs,
  fileDiffRetentionSize,
  MAX_RETAINED_DIFF_CHARACTERS,
  MAX_RETAINED_DIFF_FILES,
  MAX_RETAINED_DIFF_LINES
} from "../packages/zcode-tui/src/file-diff-budget.ts";
import type { FileDiffData } from "../packages/zcode-tui/src/file-diff-view.ts";

function diff(file: number, lines = 100, width = 200): FileDiffData {
  return {
    filePath: `src/file_${file}.ts`,
    additions: lines,
    deletions: 0,
    structuredPatch: [{
      header: `@@ file ${file} @@`,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines,
      lines: Array.from({ length: lines }, (_, index) => `+${file}:${index}:${"x".repeat(width)}`)
    }]
  };
}

describe("retained file diff budget", () => {
  test("leaves ordinary diffs untouched", () => {
    const source = [diff(1, 2, 20)];
    expect(boundedFileDiffs(source)).toBe(source);
  });

  test("bounds files, lines, and characters while keeping visible prefixes and stats", () => {
    const source = Array.from({ length: 40 }, (_, index) => diff(index));
    const retained = boundedFileDiffs(source);
    const size = fileDiffRetentionSize(retained);

    expect(size.files).toBeLessThanOrEqual(MAX_RETAINED_DIFF_FILES);
    expect(size.lines).toBeLessThanOrEqual(MAX_RETAINED_DIFF_LINES);
    expect(size.characters).toBeLessThanOrEqual(MAX_RETAINED_DIFF_CHARACTERS);
    expect(retained[0]).toMatchObject({
      filePath: "src/file_0.ts",
      additions: 100,
      deletions: 0
    });
    expect(retained[0]?.structuredPatch[0]?.lines[0]).toBe(`+0:0:${"x".repeat(200)}`);
    expect(retained.some((file) => file.truncated)).toBeTrue();
  });

  test("enforces the file-count limit independently of line and character limits", () => {
    const retained = boundedFileDiffs(
      Array.from({ length: 40 }, (_, index) => diff(index, 1, 1))
    );

    expect(retained).toHaveLength(MAX_RETAINED_DIFF_FILES);
    expect(retained.at(-1)?.truncated).toBeTrue();
  });

  test("clips a final line without splitting a surrogate pair", () => {
    const source: FileDiffData[] = [{
      filePath: "a.ts",
      additions: 1,
      deletions: 0,
      structuredPatch: [{ lines: ["+prefix 👨‍👩‍👧‍👦 suffix"] }]
    }];
    const retained = boundedFileDiffs(source, { characters: 15, files: 1, lines: 1 });
    const line = retained[0]?.structuredPatch[0]?.lines[0] ?? "";

    expect(fileDiffRetentionSize(retained).characters).toBeLessThanOrEqual(15);
    expect(retained[0]?.truncated).toBeTrue();
    expect(line).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
});
