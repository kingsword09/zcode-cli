import { describe, expect, test } from "bun:test";

import {
  DiffDetailPage,
  diffBrowserSources,
  diffFileDescription
} from "../packages/zcode-tui/src/diff-browser.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

const file = {
  filePath: "src/index.ts",
  additions: 1,
  deletions: 1,
  structuredPatch: [{ oldStart: 1, newStart: 1, lines: ["-old", "+new"] }],
  status: "modified" as const
};

describe("diff browser", () => {
  test("orders current changes before newest turn sources", () => {
    const sources = diffBrowserSources(
      { files: [file], truncated: false },
      [{ id: "turn_1", index: 1, prompt: "Change it", files: [file], additions: 1, deletions: 1 }]
    );
    expect(sources.map((source) => source.label)).toEqual(["Current changes", "Turn 1"]);
    expect(sources[1]?.description).toContain("Change it");
  });

  test("renders bounded detail pages and file state", () => {
    const page = new DiffDetailPage(createTheme(false), file, 0, 2);
    expect(page.pageCount(80)).toBeGreaterThan(1);
    expect(page.render(80).at(-1)).toContain("Page 1/");
    expect(diffFileDescription({ ...file, isBinary: true })).toContain("binary");
  });
});
