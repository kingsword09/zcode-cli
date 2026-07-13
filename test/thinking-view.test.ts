import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { ThinkingView } from "../packages/zcode-tui/src/thinking-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

describe("TUI thinking view", () => {
  test("streams reasoning into one card and settles without duplicating text", () => {
    const view = new ThinkingView(createTheme(false));

    expect(view.render(52)).toEqual([]);
    view.append("Inspecting ");
    view.append("the repository.");

    const active = view.render(52).map((line) => line.trimEnd()).join("\n");
    expect(active).toContain("◇ Thinking · active");
    expect(active).toContain("Inspecting the repository.");
    expect(active.match(/Inspecting the repository\./g)).toHaveLength(1);

    view.complete();
    const complete = view.render(52).map((line) => line.trimEnd()).join("\n");
    expect(complete).toContain("◇ Thought");
    expect(complete).not.toContain("· active");
    expect(complete.match(/Inspecting the repository\./g)).toHaveLength(1);
  });

  test("wraps Markdown and CJK reasoning within narrow terminals", () => {
    const view = new ThinkingView(createTheme(false));
    view.append("**检查结果**：需要继续分析工具调用与终端布局，确保所有内容保持可读。 ");
    view.append("`reasoning_delta` remains structured.");

    const lines = view.render(30);
    expect(lines.join("\n")).toContain("检查结果");
    expect(lines.join("\n")).toContain("reasoning_delta");
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
  });
});
