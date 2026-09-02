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
    expect(complete).toContain("Ctrl+O to expand");
    expect(complete).not.toContain("Inspecting the repository.");

    view.setExpanded(true);
    const expanded = view.render(52).map((line) => line.trimEnd()).join("\n");
    expect(expanded.match(/Inspecting the repository\./g)).toHaveLength(1);
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

  test("resumes the same card when reasoning continues after a text block", () => {
    const view = new ThinkingView(createTheme(false));

    view.append("Inspecting ");
    view.complete();
    view.append("the remaining files.");

    const active = view.render(52).map((line) => line.trimEnd()).join("\n");
    expect(active).toContain("◇ Thinking · active");
    expect(active.match(/Inspecting the remaining files\./g)).toHaveLength(1);

    view.complete();
    expect(view.render(52).join("\n")).toContain("◇ Thought");
  });

  test("keeps routine thinking content free of full-width backgrounds", () => {
    const view = new ThinkingView(createTheme(true, "light"));
    view.append("Inspecting the runtime.");
    expect(view.render(60).join("\n")).not.toContain("\x1b[48;5;");
  });

  test("bounds the active stream while retaining the complete trace for search and expansion", () => {
    const view = new ThinkingView(createTheme(false));
    for (let index = 0; index < 40; index += 1) {
      view.append(`reasoning line ${index}\n`);
    }

    const active = view.render(80).join("\n");
    expect(active).not.toContain("reasoning line 0");
    expect(active).toContain("reasoning line 39");
    expect(view.getSearchText()).toContain("reasoning line 0");
    expect(view.getSearchText()).toContain("reasoning line 39");

    view.complete();
    expect(view.render(80).join("\n")).not.toContain("reasoning line 0");

    view.setExpanded(true);
    const expanded = view.render(80).join("\n");
    expect(expanded).toContain("reasoning line 0");
    expect(expanded).toContain("reasoning line 39");
  });

  test("does not split a surrogate pair at the live-tail boundary", () => {
    const view = new ThinkingView(createTheme(false));
    view.append("prefix ".repeat(3_000));
    view.append("tail 👋");

    const active = view.render(80).join("\n");
    expect(active).toContain("tail 👋");
    expect(active).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(active).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
});
