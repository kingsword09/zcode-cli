import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import { ToolTreeView } from "../packages/zcode-tui/src/tool-tree-view.ts";
import { ToolExecutionView } from "../packages/zcode-tui/src/tool-view.ts";

function tree(name: string, state = "complete"): ToolTreeView {
  const theme = createTheme(false);
  return new ToolTreeView(theme, new ToolExecutionView(theme, { name, state }));
}

describe("TUI tool tree", () => {
  test("renders running children and collapses completed descendants", () => {
    const parent = tree("Agent", "running");
    parent.addChild(tree("Read"));
    parent.addChild(tree("Grep"));

    expect(parent.render(80).join("\n")).toContain("Read");
    parent.tool.update({ name: "Agent", state: "complete" });
    const collapsed = parent.render(80).join("\n");
    expect(collapsed).toContain("2 child tools");
    expect(collapsed).not.toContain("Read");

    parent.setExpanded(true);
    expect(parent.render(80).join("\n")).toContain("Read");
  });

  test("deduplicates children and supports moving between parents", () => {
    const first = tree("Agent");
    const second = tree("Agent");
    const child = tree("Bash");
    first.addChild(child);
    first.addChild(child);
    expect(first.getChildren()).toHaveLength(1);

    expect(first.removeChild(child)).toBe(true);
    second.addChild(child);
    second.setExpanded(true);
    expect(first.getChildren()).toHaveLength(0);
    expect(second.render(80).join("\n")).toContain("Bash");
  });

  test("keeps collapsed descendant hints inside very narrow terminals", () => {
    const parent = tree("Agent");
    parent.addChild(tree("Read"));
    for (const width of [8, 20, 36]) {
      expect(parent.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
});
