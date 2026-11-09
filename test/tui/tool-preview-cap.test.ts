import { describe, expect, test } from "bun:test";

import { createTheme } from "../../packages/zcode-tui/src/theme.ts";
import { ToolExecutionView } from "../../packages/zcode-tui/src/tool-view.ts";

const theme = createTheme(true);

const tallOutput = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `line ${i + 1} of streaming output`).join("\n");

function cardBodyLines(options: Parameters<typeof ToolExecutionView.prototype.update>[0] & { name: string; state: string }): string[] {
  const view = new ToolExecutionView(theme, options);
  const rendered = view.render(100);
  return rendered.filter((line) => line.trim().length > 0);
}

describe("live tool card viewport-aware preview cap", () => {
  test("running card caps its preview to previewLines", () => {
    const lines = cardBodyLines({
      name: "Bash",
      state: "running",
      progress: { elapsedMs: 4200, stdoutTail: tallOutput(60) },
      previewLines: 3
    });
    const bodyText = lines.join("\n");
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(bodyText).toContain("… 58 more lines · Ctrl+O to expand");
  });

  test("running card without previewLines keeps the default preview", () => {
    const lines = cardBodyLines({
      name: "Bash",
      state: "running",
      progress: { elapsedMs: 4200, stdoutTail: tallOutput(60) }
    });
    expect(lines.join("\n")).toContain("… 45 more lines · Ctrl+O to expand");
  });

  test("completed card is unaffected by the live cap", () => {
    const view = new ToolExecutionView(theme, {
      name: "Bash",
      state: "running",
      progress: { elapsedMs: 4200, stdoutTail: tallOutput(60) },
      previewLines: 3
    });
    view.update({
      name: "Bash",
      state: "complete",
      result: tallOutput(60),
      progress: { durationMs: 5100 }
    });
    const bodyText = view.render(100).filter((line) => line.trim().length > 0).join("\n");
    expect(bodyText).toContain("… 45 more lines · Ctrl+O to expand");
  });

  test("cap never drops the header or status rows", () => {
    const lines = cardBodyLines({
      name: "Bash",
      state: "running",
      progress: { elapsedMs: 4200, stdoutTail: tallOutput(60) },
      previewLines: 2
    });
    expect(lines[0]).toContain("Bash");
    expect(lines[0]).toContain("running");
    expect(lines.length).toBeLessThanOrEqual(5);
  });
});
