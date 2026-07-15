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
    expect(larger).toContain("output truncated");
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

  test("reserves full-width backgrounds for permission and failure states", () => {
    const view = new ToolExecutionView(createTheme(true), {
      name: "Bash",
      state: "running",
      input: { command: "bun test" }
    });

    expect(view.render(72).join("\n")).not.toContain("\x1b[48;5;");
    view.update({ name: "Bash", state: "complete", input: { command: "bun test" } });
    expect(view.render(72).join("\n")).not.toContain("\x1b[48;5;");
    view.update({ name: "Bash", state: "waiting_permission", input: { command: "bun test" } });
    expect(view.render(72).join("\n")).toContain("\x1b[38;5;252;48;5;236m");
    view.update({ name: "Bash", state: "failed", input: { command: "bun test" } });
    expect(view.render(72).join("\n")).toContain("\x1b[38;5;252;48;5;52m");
  });

  test("strips external background, inverse and hidden SGR from tool output", () => {
    const view = new ToolExecutionView(createTheme(true, "light"), {
      name: "Bash",
      state: "complete",
      input: { command: "printf color" },
      result: "\x1b[47;8;7mvisible output\x1b[0m plain output"
    });
    const rendered = view.render(72).join("\n");

    expect(rendered).toContain("visible output plain output");
    expect(rendered).not.toContain("\x1b[47;8;7m");
    expect(rendered).not.toContain("\x1b[48;5;");
  });

  test("uses an explicit readable foreground for tool names on light terminals", () => {
    const view = new ToolExecutionView(createTheme(true, "light"), {
      name: "Bash",
      state: "complete",
      input: { command: "bun test" },
      result: "212 pass"
    });

    expect(view.render(72).join("\n")).toContain("\x1b[1;38;5;236mBash");
  });

  test("falls back to JSON for unknown structured arrays and reports hidden images", () => {
    const structured = toolCard({
      name: "\x1b[47;8mUnknownTool\x1b[0m",
      state: "complete",
      result: [{ foo: "bar" }, { count: 2 }]
    });
    expect(structured).toContain("UnknownTool");
    expect(structured).not.toContain("\x1b[");
    expect(structured).toContain('"foo": "bar"');
    expect(structured).toContain('"count": 2');

    const image = {
      type: "image",
      source: { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", media_type: "image/png" }
    };
    const view = new ToolExecutionView(createTheme(false), {
      name: "UnknownTool",
      state: "complete",
      result: Array.from({ length: 6 }, () => image)
    });
    expect(view.render(80).join("\n")).toContain("4 of 6 images shown · Ctrl+O to show all");
    expect(view.hasHiddenContent()).toBe(true);
    view.setExpanded(true);
    expect(view.render(80).join("\n")).toContain("6 images");
    expect(view.hasHiddenContent()).toBe(false);
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
