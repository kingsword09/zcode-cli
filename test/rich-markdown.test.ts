import { describe, expect, test } from "bun:test";
import { Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";

import {
  RichMarkdown,
  isPlainMarkdownBlock,
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
  test("uses the plain fast path only when Markdown semantics are impossible", () => {
    const plain = [
      "Ordinary prose with punctuation (42), 中文宽度 and emoji ✅.",
      "Paths like packages/zcode-tui/src stay plain.",
      "A sentence with a mid-line hyphen stays plain."
    ];
    const markdown = [
      "# heading",
      "- list item",
      "+ list item",
      "1. ordered item",
      "---",
      "    indented code",
      "**bold**",
      "`code`",
      "[link](target)",
      "<https://example.com>",
      "https://example.com",
      "ftp://example.com",
      "www.example.com",
      "person@example.com",
      "AT&amp;T",
      "left | right",
      "tab\tcontent",
      "first line\nsecond line"
    ];

    for (const source of plain) expect(isPlainMarkdownBlock(source)).toBeTrue();
    for (const source of markdown) expect(isPlainMarkdownBlock(source)).toBeFalse();
  });

  test("plain fast path is byte-identical to Markdown at supported widths and themes", () => {
    const sources = [
      "Ordinary prose with punctuation (42), 中文宽度 and emoji ✅.",
      "This deliberately long sentence wraps across several terminal rows while remaining plain text for every rendered frame."
    ];
    for (const color of [false, true]) {
      const theme = createTheme(color);
      for (const source of sources) {
        const text = new Text(source, 1, 0);
        const markdown = new Markdown(source, 1, 0, theme.markdown);
        for (const width of [40, 60, 80, 100]) {
          expect(text.render(width)).toEqual(markdown.render(width));
        }
      }
    }
  });

  test("plain streaming prefixes stay byte-identical to one-shot Markdown", () => {
    const source = "Ordinary prose grows token by token with 中文宽度, punctuation (42), and emoji ✅.";
    for (const color of [false, true]) {
      const theme = createTheme(color);
      for (let end = 1; end <= source.length; end += 1) {
        const prefix = source.slice(0, end);
        expect(isPlainMarkdownBlock(prefix)).toBeTrue();
        const streamed = new RichMarkdown("", 1, theme);
        for (const character of prefix) streamed.appendText(character);
        for (const width of [40, 60, 80, 100]) {
          const expected = new Markdown(prefix, 1, 0, theme.markdown).render(width);
          expect(streamed.render(width)).toEqual(expected);
        }
      }
    }
  });

  test("incremental plain wrapping matches Text for difficult append boundaries", () => {
    const sources = [
      "word   boundary spacing keeps only meaningful terminal cells",
      "supercalifragilisticexpialidociouscontinuestogrowwithoutspaces",
      "中文宽度连续换行测试以及更多字符",
      "family emoji 👨‍👩‍👧‍👦 and flags 🇨🇳 remain complete"
    ];
    const widths = [40, 17, 60, 11, 80, 100];

    for (const source of sources) {
      const component = new RichMarkdown("", 1, createTheme(false));
      let prefix = "";
      for (const character of source) {
        prefix += character;
        component.appendText(character);
        const plain = prefix.trim();
        for (const width of widths) {
          expect(component.render(width)).toEqual(new Text(plain, 1, 0).render(width));
        }
      }

      component.setText("replacement text that is not an append");
      for (const width of widths) {
        expect(component.render(width)).toEqual(
          new Text("replacement text that is not an append", 1, 0).render(width)
        );
      }
      component.invalidate();
      expect(component.render(40)).toEqual(
        new Text("replacement text that is not an append", 1, 0).render(40)
      );
    }
  });

  test("switches a growing plain tail to Markdown as soon as syntax appears", () => {
    const component = new RichMarkdown("Plain tail", 1, createTheme(false));
    component.render(80);
    const internal = component as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(internal.renderedSegments[0]?.component).not.toBeInstanceOf(Markdown);

    component.appendText(" with **bold**");
    expect(component.render(80).join("\n")).toContain("bold");
    expect(internal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

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

  test("renders chunked streaming input exactly like one-shot input", () => {
    const source = [
      "# Heading",
      "",
      "Paragraph with **bold** and \x1b[31muntrusted color\x1b[0m.",
      "",
      "| Name | Value |",
      "| --- | ---: |",
      "| 中文 | 42 |",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "- first",
      "- second"
    ].join("\n");
    const chunks = [
      source.slice(0, 19),
      source.slice(19, 39),
      source.slice(39, 52),
      source.slice(52, 97),
      source.slice(97)
    ];
    const streamed = new RichMarkdown("", 1, createTheme(false));
    for (const chunk of chunks) streamed.appendText(chunk);
    streamed.finishText();
    const complete = new RichMarkdown(source, 1, createTheme(false));

    expect(streamed.getSearchText()).toBe(complete.getSearchText());
    for (const width of [40, 60, 80, 100]) {
      expect(streamed.render(width)).toEqual(complete.render(width));
    }
  });

  test("keeps completed Markdown segment caches when only the tail grows", () => {
    const component = new RichMarkdown("stable paragraph\n\nstream", 1, createTheme(false));
    component.render(80);
    const internal = component as unknown as {
      renderedSegments: Array<{ component: { cachedLines?: string[] } }>;
    };
    const stableLines = internal.renderedSegments[0]?.component.cachedLines;
    expect(stableLines).toBeDefined();

    component.appendText("ing tail");
    component.render(80);
    expect(internal.renderedSegments[0]?.component.cachedLines).toBe(stableLines);
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
