import { describe, expect, test } from "bun:test";

import { BoundedToolText } from "../packages/zcode-tui/src/bounded-tool-text.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import { fileDiffRetentionSize } from "../packages/zcode-tui/src/file-diff-budget.ts";
import {
  ToolExecutionView,
  toolCard,
  toolSucceeded
} from "../packages/zcode-tui/src/tool-view.ts";
import {
  MAX_RETAINED_TOOL_PAYLOAD_CHARACTERS,
  toolPayloadSize
} from "../packages/zcode-tui/src/tool-payload.ts";

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

  test("keeps terminal Error messages compact after payload retention", () => {
    const card = toolCard({ name: "Bash", state: "failed", error: new Error("boom") });

    expect(card).toContain("Error: boom");
    expect(card).not.toContain('"name": "Error"');
    expect(card).not.toContain('"message": "boom"');
  });

  test("keeps active payloads intact and compacts them at the terminal state", () => {
    const result = { stdout: `HEAD-${"x".repeat(1_000_000)}-TAIL`, success: true };
    const view = new ToolExecutionView(createTheme(false), {
      name: "Bash",
      state: "running",
      input: { command: "generate" },
      result
    });
    const internal = view as unknown as {
      options: {
        error?: unknown;
        input?: unknown;
        inputText?: string;
        progress?: unknown;
        result?: unknown;
        retainedPayloadTruncated?: boolean;
      };
    };
    expect(internal.options.result).toBe(result);

    view.update({
      name: "Bash",
      state: "complete",
      input: { command: "generate" },
      result
    });
    const size = toolPayloadSize([
      internal.options.input,
      internal.options.inputText,
      internal.options.result,
      internal.options.error,
      internal.options.progress
    ]);
    const retained = JSON.stringify(internal.options.result);
    expect(internal.options.result).not.toBe(result);
    expect(size.characters).toBeLessThanOrEqual(MAX_RETAINED_TOOL_PAYLOAD_CHARACTERS);
    expect(retained).toContain("HEAD-");
    expect(retained).toContain("-TAIL");
    expect(internal.options.retainedPayloadTruncated).toBeTrue();
    expect(view.render(80).join("\n")).toContain("completed tool payload retained as a bounded preview");
  });

  test("materializes active bounded streams only when the dirty view renders", () => {
    const output = new BoundedToolText();
    let materializations = 0;
    const value = output.value.bind(output);
    output.value = () => {
      materializations += 1;
      return value();
    };
    const view = new ToolExecutionView(createTheme(false), {
      name: "Bash",
      state: "running",
      input: { command: "stream" },
      result: output
    });

    for (let index = 0; index < 10_000; index += 1) {
      output.append("0123456789");
      view.update({
        name: "Bash",
        state: "running",
        input: { command: "stream" },
        result: output
      });
    }

    expect(materializations).toBe(0);
    const rendered = view.render(80).join("\n");
    expect(materializations).toBe(1);
    expect(rendered).toContain("output characters omitted from active tool stream");
    view.render(80);
    expect(materializations).toBe(1);
  });

  test("keeps bounded input byte-identical below the limit and marks terminal truncation", () => {
    const input = new BoundedToolText('{"command":"printf ok"}');
    expect(toolCard({ name: "Bash", state: "running", inputText: input }))
      .toBe(toolCard({ name: "Bash", state: "running", inputText: input.value() }));

    input.append("x".repeat(100_000));
    const completed = new ToolExecutionView(createTheme(false), {
      name: "UnknownTool",
      state: "complete",
      inputText: input,
      result: { success: true }
    });
    expect(completed.render(80).join("\n"))
      .toContain("completed tool payload retained as a bounded preview");
  });

  test("retains bounded mutation diffs without the original content", () => {
    const content = "x".repeat(1_000_000);
    const input = { file_path: "src/large.ts", content };
    const view = new ToolExecutionView(createTheme(false), {
      name: "Write",
      state: "complete",
      input,
      result: { success: true }
    });
    const internal = view as unknown as {
      options: { diffs?: []; input?: unknown; retainedPayloadTruncated?: boolean };
    };

    expect(internal.options.input).not.toBe(input);
    expect(toolPayloadSize(internal.options.input).characters)
      .toBeLessThanOrEqual(MAX_RETAINED_TOOL_PAYLOAD_CHARACTERS);
    expect(fileDiffRetentionSize(internal.options.diffs ?? []).characters).toBeLessThanOrEqual(250_000);
    expect(internal.options.retainedPayloadTruncated).toBeTrue();
  });

  test("replaces oversized completed image data with a searchable omission summary", () => {
    const data = "a".repeat(1_000_000);
    const view = new ToolExecutionView(createTheme(false), {
      name: "Read",
      state: "complete",
      result: { content: [{ type: "image", mimeType: "image/png", data }] }
    });
    const rendered = view.render(80).join("\n");

    expect(rendered).toContain("completed tool payload retained as a bounded preview");
    expect(view.getSearchText()).toContain("binary payload omitted: 1000000 characters");
    expect(view.getSearchText()).not.toContain(data.slice(0, 10_000));
  });

  test("coalesces rapid tool progress updates until the next render", () => {
    const theme = createTheme(false);
    const bold = theme.bold;
    let rebuilds = 0;
    theme.bold = (text) => {
      rebuilds += 1;
      return bold(text);
    };
    const view = new ToolExecutionView(theme, {
      name: "Bash",
      state: "running",
      input: { command: "long-running-task" }
    });

    for (let index = 0; index < 500; index += 1) {
      view.update({
        name: "Bash",
        state: "running",
        input: { command: "long-running-task" },
        progress: {
          stdoutBytes: index,
          stdoutTail: `progress ${index}`
        }
      });
    }

    expect(rebuilds).toBe(0);
    expect(view.render(80).join("\n")).toContain("progress 499");
    expect(rebuilds).toBe(1);
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
