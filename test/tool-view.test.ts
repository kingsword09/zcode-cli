import { describe, expect, test } from "bun:test";

import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import {
  ToolExecutionView,
  toolCard,
  toolSucceeded
} from "../packages/zcode-tui/src/tool-view.ts";

describe("TUI tool execution view", () => {
  test("renders a scannable tool summary instead of raw input JSON", () => {
    const card = toolCard({
      name: "Read",
      state: "complete",
      input: { file_path: "/tmp/example.ts" },
      result: { output: "source text", success: true }
    });

    expect(card).toContain("✓ Read /tmp/example.ts");
    expect(card).not.toContain("file_path");
    expect(card).toContain("Read 1 line");
    expect(card).toContain("Ctrl+O to expand");
    expect(toolSucceeded({ success: true })).toBe(true);
    expect(toolSucceeded({ success: false })).toBe(false);
    expect(toolSucceeded({ status: "failed" })).toBe(false);
  });

  test("bounds large output previews", () => {
    const card = toolCard({ name: "Bash", state: "complete", result: "x".repeat(2_000) });
    expect(card).not.toContain("more characters");
    expect(card.length).toBeLessThan(2_500);

    const larger = toolCard({ name: "Bash", state: "complete", result: "x".repeat(4_000) });
    expect(larger).toContain("more characters");
    expect(larger.length).toBeLessThan(2_700);
  });

  test("styles mutation diffs and keeps running state compact", () => {
    const view = new ToolExecutionView(createTheme(false), {
      name: "ApplyPatch",
      state: "running",
      input: {
        patch_text: [
          "*** Begin Patch",
          "*** Update File: src/app.ts",
          "@@ -1,1 +1,1 @@",
          "-old",
          "+new",
          "*** End Patch"
        ].join("\n")
      }
    });
    const output = view.render(80).map((line) => line.trimEnd()).join("\n");

    expect(output).toContain("● ApplyPatch src/app.ts +1 -1");
    expect(output).toContain("@@ -1,1 +1,1 @@");
    expect(output).toContain("│- old");
    expect(output).toContain("│+ new");
  });

  test("uses a quiet full-width background that recedes after completion", () => {
    const view = new ToolExecutionView(createTheme(true), {
      name: "Bash",
      state: "running",
      input: { command: "bun test" }
    });

    expect(view.render(72).join("\n")).toContain("\x1b[48;5;236m");
    view.update({ name: "Bash", state: "complete", input: { command: "bun test" } });
    expect(view.render(72).join("\n")).toContain("\x1b[48;5;234m");
    view.update({ name: "Bash", state: "failed", input: { command: "bun test" } });
    expect(view.render(72).join("\n")).toContain("\x1b[48;5;52m");
  });

  test("hides metadata-only success results and surfaces embedded errors", () => {
    expect(toolCard({
      name: "Write",
      state: "complete",
      input: { path: "result.txt", content: "done" },
      result: { success: true, status: "completed" }
    })).not.toContain('"success"');

    expect(toolCard({
      name: "Bash",
      state: "failed",
      input: { command: "false" },
      result: { status: "failed", error: "Command exited with code 1" }
    })).toContain("Error: Command exited with code 1");
  });
});
