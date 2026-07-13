import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  fileDiffCard,
  fileDiffsForTool,
  FileDiffView,
  wordDiffLines
} from "../packages/zcode-tui/src/file-diff-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import { toolCard } from "../packages/zcode-tui/src/tool-view.ts";

const officialDisplay = {
  kind: "file_diff",
  filePath: "packages/zcode-tui/src/events.ts",
  additions: 2,
  deletions: 1,
  structuredPatch: [{
    oldStart: 20,
    oldLines: 3,
    newStart: 20,
    newLines: 4,
    lines: [
      " function normalizeEvent(value: unknown) {",
      "-  kind: asString(body.kind),",
      "+  const type = asString(value.type);",
      "+  kind: asString(body.kind) ?? runtimeToolKind(type),",
      " }"
    ]
  }]
};

describe("TUI file diff view", () => {
  test("marks changed words independently inside paired diff lines", () => {
    const themed = wordDiffLines("const value = 1;", "const value = 20;", createTheme(true));
    expect(themed.removed).toContain("\x1b[1;38;5;231;48;5;88m1");
    expect(themed.added).toContain("\x1b[1;38;5;231;48;5;28m20");
  });

  test("renders official file_diff displays with Pierre-style gutters", () => {
    const card = toolCard({
      name: "Edit",
      state: "complete",
      input: {
        file_path: "packages/zcode-tui/src/events.ts",
        old_string: "kind: asString(body.kind)",
        new_string: "kind: asString(body.kind) ?? runtimeToolKind(type)"
      },
      result: { success: true, display: officialDisplay }
    });

    expect(card).toContain("✓ Edit packages/zcode-tui/src/events.ts +2 -1");
    expect(card).toContain("@@ -20,3 +20,4 @@");
    expect(card).toContain("21    │-   kind: asString(body.kind),");
    expect(card).toContain("   21 │+   const type = asString(value.type);");
    expect(card).not.toContain("old_string");
    expect(card).not.toContain('"display"');
  });

  test("parses official ApplyPatch patch_text including multiple files", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@ -1,2 +1,2 @@",
      "-const oldValue = 1;",
      "+const newValue = 2;",
      " export default newValue;",
      "*** Add File: src/new.ts",
      "+export const created = true;",
      "*** End Patch"
    ].join("\n");
    const diffs = fileDiffsForTool("ApplyPatch", { patch_text: patchText }, undefined, "running");
    const card = fileDiffCard({ toolName: "ApplyPatch", state: "running", diffs });

    expect(diffs).toHaveLength(2);
    expect(card).toContain("● ApplyPatch src/app.ts +1 -1");
    expect(card).toContain("↳ src/new.ts +1 -0");
    expect(card).toContain("│- const oldValue = 1;");
    expect(card).toContain("│+ const newValue = 2;");
    expect(card).not.toContain("*** Begin Patch");
  });

  test("renders successful new Write content as additions", () => {
    const card = toolCard({
      name: "Write",
      state: "complete",
      input: { file_path: "src/new.ts", content: "export const one = 1;\nexport const two = 2;\n" },
      result: { success: true }
    });

    expect(card).toContain("✓ Write src/new.ts +2 -0");
    expect(card).toContain("│+ export const one = 1;");
    expect(card).toContain("│+ export const two = 2;");
  });

  test("uses distinct added, removed, and hunk backgrounds", () => {
    const view = new FileDiffView(createTheme(true), {
      toolName: "Edit",
      state: "complete",
      diffs: [officialDisplay]
    });
    const rendered = view.render(72).join("\n");

    expect(rendered).toContain("\x1b[38;5;120;48;5;22m");
    expect(rendered).toContain("\x1b[38;5;210;48;5;52m");
    expect(rendered).toContain("\x1b[38;5;117;48;5;24m");
  });

  test("wraps CJK changes within narrow terminals", () => {
    const view = new FileDiffView(createTheme(false), {
      toolName: "Edit",
      state: "complete",
      diffs: [{
        filePath: "src/中文.ts",
        additions: 1,
        deletions: 0,
        structuredPatch: [{
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+这是一个需要在窄终端中正确换行的中文代码修改"]
        }]
      }]
    });
    const lines = view.render(28);

    expect(lines.join("\n")).toContain("中文.ts");
    expect(lines.every((line) => visibleWidth(line) <= 28)).toBe(true);
  });

  test("bounds very large diffs", () => {
    const lines = Array.from({ length: 200 }, (_, index) => `+line ${index + 1}`);
    const card = fileDiffCard({
      toolName: "Write",
      state: "complete",
      diffs: [{
        filePath: "large.ts",
        additions: lines.length,
        deletions: 0,
        structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }]
      }]
    });

    expect(card).toContain("… diff truncated");
    expect(card).not.toContain("line 200");
  });
});
