import { describe, expect, test } from "bun:test";

import { createTheme } from "../../packages/zcode-tui/src/theme.ts";
import { ToolExecutionView } from "../../packages/zcode-tui/src/tool-view.ts";

const theme = createTheme(true);

const tallOutput = (lines: number): string =>
  Array.from({ length: lines }, (_, index) => `line ${index + 1} of streaming output`).join("\n");

describe("live tool card viewport-aware preview cap", () => {
  test("running card caps its total rendered rows including the expansion hint", () => {
    const view = new ToolExecutionView(theme, {
      name: "Bash",
      state: "running",
      progress: { elapsedMs: 4200, stdoutTail: tallOutput(60) },
      previewRows: 6
    });
    const lines = view.render(100);
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toContain("Ctrl+O to expand");
    expect(view.hasHiddenContent()).toBe(true);
  });

  test("running card without a row budget keeps the default preview", () => {
    const view = new ToolExecutionView(theme, {
      name: "Bash",
      state: "running",
      progress: { elapsedMs: 4200, stdoutTail: tallOutput(60) }
    });
    expect(view.render(100).join("\n")).toContain("… 45 more lines · Ctrl+O to expand");
  });

  test.each(["complete", "failed"])("%s card ignores the live cap even when supplied", (state) => {
    const view = new ToolExecutionView(theme, {
      name: "Bash",
      state: "running",
      progress: { elapsedMs: 4200, stdoutTail: tallOutput(60) },
      previewRows: 3
    });
    expect(view.render(100)).toHaveLength(3);
    view.update({
      name: "Bash",
      state,
      result: tallOutput(60),
      progress: { durationMs: 5100 },
      previewRows: () => { throw new Error("Terminal cards must not evaluate the live budget."); }
    });
    const lines = view.render(100);
    expect(lines).toHaveLength(18);
    expect(lines.join("\n")).toContain("… 45 more lines · Ctrl+O to expand");
  });

  test("a three-row budget preserves the header, status and expansion hint", () => {
    const view = new ToolExecutionView(theme, {
      name: "Bash",
      state: "running",
      progress: { elapsedMs: 4200, stdoutTail: tallOutput(60) },
      previewRows: 3
    });
    const lines = view.render(100);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Bash");
    expect(lines[0]).toContain("running");
    expect(lines[1]).toContain("4s");
    expect(lines[2]).toContain("Ctrl+O to expand");
  });

  test("the cap applies after ANSI and wide-character output wraps", () => {
    const view = new ToolExecutionView(theme, {
      name: "Bash",
      state: "running",
      progress: { stdoutTail: `\x1b[32m${"宽字符 output ".repeat(100)}\x1b[0m` },
      previewRows: 5
    });
    expect(view.render(40)).toHaveLength(5);
    expect(view.render(100)).toHaveLength(5);
  });

  test("input, result and error sections share one row budget", () => {
    const view = new ToolExecutionView(theme, {
      name: "custom_tool",
      state: "running",
      input: { content: tallOutput(20) },
      result: tallOutput(20),
      error: tallOutput(20),
      previewRows: 6
    });
    expect(view.render(60)).toHaveLength(6);
  });

  test("the live budget is re-evaluated on every render without an update", () => {
    let rows: number | undefined = 4;
    const view = new ToolExecutionView(theme, {
      name: "Bash",
      state: "running",
      progress: { stdoutTail: "wrapped output ".repeat(30) },
      previewRows: () => rows
    });
    expect(view.render(40)).toHaveLength(4);
    expect(view.hasHiddenContent()).toBe(true);
    rows = 8;
    expect(view.render(40)).toHaveLength(8);
    rows = undefined;
    expect(view.render(40).length).toBeGreaterThan(8);
    expect(view.hasHiddenContent()).toBe(false);
  });

  test("expanded cards retain access to all output", () => {
    const view = new ToolExecutionView(theme, {
      name: "Bash",
      state: "running",
      progress: { stdoutTail: tallOutput(60) },
      previewRows: 3
    });
    view.setExpanded(true);
    const lines = view.render(100);
    expect(lines.length).toBeGreaterThan(60);
    expect(lines.join("\n")).toContain("line 60 of streaming output");
  });

  test("a minimal budget retains the header", () => {
    const view = new ToolExecutionView(theme, {
      name: "Bash",
      state: "running",
      progress: { stdoutTail: tallOutput(60) },
      previewRows: 1
    });
    const lines = view.render(100);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Bash");
    expect(view.hasHiddenContent()).toBe(true);
  });
});
