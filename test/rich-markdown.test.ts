import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  RichMarkdown,
  normalizeMermaidTerminalWidth,
  renderMermaidPreview,
  splitMarkdownSegments,
  splitStreamingMarkdownSegments
} from "../packages/zcode-tui/src/rich-markdown.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

function terminalColumn(line: string, marker: string): number {
  const index = line.indexOf(marker);
  return index < 0 ? -1 : visibleWidth(line.slice(0, index));
}

describe("TUI rich Markdown", () => {
  test("extracts only complete Mermaid fences", () => {
    expect(splitMarkdownSegments([
      "Before",
      "```mermaid",
      "graph LR",
      "A --> B",
      "```",
      "After"
    ].join("\n"))).toEqual([
      { kind: "markdown", text: "Before" },
      { kind: "mermaid", source: "graph LR\nA --> B" },
      { kind: "markdown", text: "After" }
    ]);

    expect(splitMarkdownSegments("```mermaid\ngraph LR\nA -->")).toEqual([
      { kind: "markdown", text: "```mermaid\ngraph LR\nA -->" }
    ]);

    const nestedSource = [
      "````text",
      "```mermaid",
      "graph LR",
      "A --> B",
      "```",
      "````"
    ].join("\n");
    expect(splitMarkdownSegments(nestedSource)).toEqual([
      { kind: "markdown", text: nestedSource }
    ]);
  });

  test("stabilizes complete Markdown blocks without splitting fenced code", () => {
    expect(splitStreamingMarkdownSegments([
      "First paragraph.",
      "",
      "```ts",
      "const first = 1;",
      "",
      "const second = 2;",
      "```",
      "",
      "Streaming tail"
    ].join("\n"))).toEqual([
      { kind: "markdown", text: "First paragraph." },
      { kind: "markdown", text: "```ts\nconst first = 1;\n\nconst second = 2;\n```" },
      { kind: "markdown", text: "Streaming tail" }
    ]);
  });

  test("keeps assistant Markdown searchable while streaming", () => {
    const component = new RichMarkdown("first", 1, createTheme(false));
    component.setText("first\n\nsecond");
    expect(component.getSearchText()).toBe("first\n\nsecond");
    expect(component.render(80).join("\n")).toContain("second");
  });

  test("uses an explicit readable foreground for strong text on light terminals", () => {
    const component = new RichMarkdown(
      "### 说明\n\n- **类型** feat\n- **范围** tui\n- **描述** summary",
      1,
      createTheme(true, "light")
    );
    const rendered = component.render(80).join("\n");

    expect(rendered).toContain("\x1b[1;38;5;236m类型");
    expect(rendered).toContain("\x1b[1;38;5;236m范围");
    expect(rendered).toContain("\x1b[1;38;5;236m描述");
    expect(rendered).toContain("\x1b[38;5;25m\x1b[1m### ");
  });

  test("pages very long Markdown across internal chunk boundaries", () => {
    const component = new RichMarkdown(
      Array.from({ length: 500 }, (_, index) => `${index + 1}. task ${index + 1}`).join("\n"),
      1,
      createTheme(false)
    );
    const page = component.renderWindow(80, 79, 4);
    expect(page.totalLines).toBe(500);
    expect(page.lines.map((line) => line.trim())).toEqual([
      "80. task 80",
      "81. task 81",
      "82. task 82",
      "83. task 83"
    ]);
  });

  test("renders Mermaid flowcharts as terminal diagrams", () => {
    const preview = renderMermaidPreview("graph LR\nA[Start] --> B[Done]", 78);
    expect(preview.reason).toBeUndefined();
    expect(preview.lines?.join("\n")).toContain("Start");
    expect(preview.lines?.join("\n")).toContain("Done");
    expect(preview.lines?.join("\n")).toContain("►");

    const component = new RichMarkdown([
      "Before",
      "```mermaid",
      "graph LR",
      "A --> B",
      "```",
      "After"
    ].join("\n"), 1, createTheme(false));
    const output = component.render(80).join("\n");
    expect(output).toContain("◇ Mermaid · flowchart");
    expect(output).toContain("A");
    expect(output).toContain("B");
    expect(output).not.toContain("```mermaid");
  });

  test("supports the common Mermaid diagram families", () => {
    for (const source of [
      "stateDiagram-v2\n[*] --> Idle\nIdle --> Done",
      "sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Hi",
      "classDiagram\nAnimal <|-- Dog\nAnimal: +int age",
      "erDiagram\nCUSTOMER ||--o{ ORDER : places",
      "xychart-beta\nx-axis [a, b]\ny-axis \"Count\" 0 --> 10\nbar [3, 7]"
    ]) {
      const preview = renderMermaidPreview(source, 150);
      expect(preview.reason).toBeUndefined();
      expect(preview.lines?.length).toBeGreaterThan(0);
    }
  });

  test("keeps CJK labels aligned with diagram borders and connectors", () => {
    const source = [
      "graph TD",
      "Input[用户输入] --> Editor[编辑器面板]",
      "Editor --> Router[事件路由器]"
    ].join("\n");
    const normalized = normalizeMermaidTerminalWidth(source);
    expect(normalized).toContain("用\u200b户\u200b输\u200b入\u200b");

    const preview = renderMermaidPreview(source, 80);
    expect(preview.reason).toBeUndefined();
    expect(preview.lines?.join("\n")).not.toContain("\u200b");
    const lines = preview.lines ?? [];
    const topBorder = lines.find((line) => line.includes("┌"));
    const inputLabel = lines.find((line) => line.includes("用户输入"));
    const editorLabel = lines.find((line) => line.includes("编辑器面板"));
    expect(topBorder).toBeDefined();
    expect(inputLabel).toBeDefined();
    expect(editorLabel).toBeDefined();
    expect(visibleWidth(inputLabel ?? "")).toBe(visibleWidth(topBorder ?? ""));
    expect(visibleWidth(editorLabel ?? "")).toBe(visibleWidth(topBorder ?? ""));

    const junctionRows = lines.flatMap((line, index) => line.includes("┬") ? [index] : []);
    expect(junctionRows).toHaveLength(2);
    for (const row of junctionRows) {
      const column = terminalColumn(lines[row] ?? "", "┬");
      expect(terminalColumn(lines[row + 1] ?? "", "│")).toBe(column);
      expect(terminalColumn(lines[row + 2] ?? "", "▼")).toBe(column);
    }
  });

  test("preserves Mermaid source when the terminal cannot fit the diagram", () => {
    const component = new RichMarkdown([
      "```mermaid",
      "graph LR",
      "LongNode[This label is deliberately much wider than the terminal] --> B",
      "```"
    ].join("\n"), 1, createTheme(false));
    const output = component.render(24).join("\n");

    expect(output).toContain("too wide for terminal");
    expect(output).toContain("```mermaid");
    expect(output).toContain("LongNode");
  });
});
