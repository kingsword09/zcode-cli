import { describe, expect, test } from "bun:test";
import { Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";

import { CodeHighlighter } from "../packages/zcode-tui/src/code-highlighter.ts";
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

function withoutBoundaryBlankLines(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start += 1;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
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
    for (const theme of [
      createTheme(false),
      createTheme(true, "dark"),
      createTheme(true, "light")
    ]) {
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

  test("semantic inline tails stay byte-identical for every streaming prefix", () => {
    const sources = [
      "**bold prefix** ordinary tail grows token by token with punctuation (42).",
      "`inline code` ordinary tail keeps wrapping without reparsing the prefix.",
      "[link](https://example.com) ordinary tail remains a single paragraph.",
      "~~strike~~ 中文尾部和 emoji 👨‍👩‍👧‍👦 remain aligned.",
      "Ordinary lead **加粗内容** followed by a stable plain tail.",
      "**unclosed delimiter remains literal while a plain tail grows",
      "**bold** plain tail later gains *italic syntax* and then becomes plain again"
    ];
    for (const theme of [
      createTheme(false),
      createTheme(true, "dark"),
      createTheme(true, "light")
    ]) {
      for (const source of sources) {
        const component = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          component.appendText(character);
          for (const width of [40, 60, 80, 100]) {
            expect(component.render(width)).toEqual(
              new Markdown(prefix, 1, 0, theme.markdown).render(width)
            );
          }
        }
      }
    }
  });

  test("activates the incremental semantic-tail component only for inline paragraphs", () => {
    const inline = new RichMarkdown("**bold** stable plain tail", 1, createTheme(false));
    inline.render(80);
    const inlineInternal = inline as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(inlineInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingInlineMarkdown");

    const heading = new RichMarkdown("# **bold heading** stable tail", 1, createTheme(false));
    heading.render(80);
    const headingInternal = heading as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(headingInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("flat unordered lists stay byte-identical for every streaming prefix", () => {
    const sources = [
      "- first item\n- second item grows token by token\n- third item",
      "* **bold item** with more words\n+ `code item` with 中文 and emoji ✅\n- final",
      "- [ ] pending task\n- [x] completed task\n- ordinary task",
      "- flat item\n  nested continuation forces the original Markdown fallback",
      "- unordered item\n1. ordered transition also forces fallback"
    ];
    for (const theme of [
      createTheme(false),
      createTheme(true, "dark"),
      createTheme(true, "light")
    ]) {
      for (const source of sources) {
        const component = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          component.appendText(character);
          for (const width of [40, 60, 80, 100]) {
            expect(component.render(width)).toEqual(
              new RichMarkdown(prefix, 1, theme).render(width)
            );
          }
        }
      }
    }
  });

  test("activates stable rows only for strict root lists", () => {
    const list = new RichMarkdown("- one\n- two\n- three", 1, createTheme(false));
    list.render(80);
    const listInternal = list as unknown as {
      renderedSegments: Array<{
        component: {
          constructor: { name: string };
          items?: unknown[];
          widthState?: { characters: number };
        };
      }>;
    };
    expect(listInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");
    expect(listInternal.renderedSegments[0]?.component.items).toBeUndefined();
    expect(listInternal.renderedSegments[0]?.component.widthState?.characters)
      .toBeLessThanOrEqual(2_000_000);

    const ordered = new RichMarkdown("1. one\n2. two", 1, createTheme(false));
    ordered.render(80);
    const orderedInternal = ordered as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(orderedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");

    const nested = new RichMarkdown(
      "- parent one\n  - child one\n  * child two\n+ parent two\n  - child three",
      1,
      createTheme(false)
    );
    nested.render(80);
    const nestedInternal = nested as unknown as {
      renderedSegments: Array<{
        component: {
          constructor: { name: string };
          items?: unknown[];
          widthState?: { characters: number };
        };
      }>;
    };
    expect(nestedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");
    expect(nestedInternal.renderedSegments[0]?.component.items).toBeUndefined();
    expect(nestedInternal.renderedSegments[0]?.component.widthState?.characters)
      .toBeLessThanOrEqual(2_000_000);

    const continuation = new RichMarkdown(
      "- parent one\n  continuation one\n+ parent two\n  continuation two",
      1,
      createTheme(false)
    );
    continuation.render(80);
    const continuationInternal = continuation as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(continuationInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");
  });

  test("keeps root one-level nested lists byte-identical for every streaming prefix", () => {
    const sources = [
      [
        "- parent one",
        "  - child one",
        "  * child two with additional wrapping words",
        "+ **parent two** with generated content",
        "  - `child two` with 中文 and emoji ✅"
      ].join("\n"),
      [
        "* [ ] pending parent task",
        "  + [x] completed nested task",
        "- parent with *italic* and ~~strike~~",
        "  - [official link](https://example.com) child"
      ].join("\n")
    ];

    for (const theme of [
      createTheme(false),
      createTheme(true, "dark"),
      createTheme(true, "light")
    ]) {
      for (const source of sources) {
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
      }
    }
  });

  test("keeps root nested child continuations byte-identical for every streaming prefix", () => {
    const source = [
      "- parent one",
      "  - child one",
      `    continuation one ${"with wrapping words ".repeat(6).trim()}`,
      "    second continuation with *italic* and ~~strike~~",
      "  + child two with `code`",
      "    中文宽度 and emoji ✅ remain aligned",
      "+ **parent two** with generated content",
      "  * [ ] pending child task",
      "    [official link](https://example.com) stays line-local"
    ].join("\n");

    for (const theme of [
      createTheme(false),
      createTheme(true, "dark"),
      createTheme(true, "light")
    ]) {
      const streamed = new RichMarkdown("", 1, theme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new Markdown(
          withoutBoundaryBlankLines(prefix),
          1,
          0,
          theme.markdown
        );
        for (const width of [40, 60, 80, 100]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
      const internal = streamed as unknown as {
        renderedSegments: Array<{
          component: {
            constructor: { name: string };
            widthState?: { characters: number };
          };
        }>;
      };
      expect(internal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingStableListMarkdown");
      expect(internal.renderedSegments[0]?.component.widthState?.characters)
        .toBeLessThanOrEqual(2_000_000);
    }
  });

  test("keeps loose root nested lists byte-identical for every streaming prefix", () => {
    const sources = [
      [
        "- parent one with **bold** output",
        "",
        "  - child one with generated words",
        "",
        "  * child two with `code` and additional wrapping words",
        "",
        "+ parent two with *italic* and ~~strike~~",
        "",
        "  + [ ] pending child task",
        "",
        "  - [official link](https://example.com) child"
      ].join("\n"),
      [
        "* [x] completed parent task",
        "",
        "  + 中文宽度 and emoji ✅ remain aligned",
        "",
        `- parent ${"with wrapping words ".repeat(6).trim()}`,
        "",
        `  * child ${"with generated output ".repeat(6).trim()}`
      ].join("\n")
    ];

    for (const theme of [
      createTheme(false),
      createTheme(true, "dark"),
      createTheme(true, "light")
    ]) {
      for (const source of sources) {
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              separatorKind?: string;
              widthState?: { characters: number };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingStableListMarkdown");
        expect(internal.renderedSegments[0]?.component.separatorKind).toBe("blank");
        expect(internal.renderedSegments[0]?.component.widthState?.characters)
          .toBeLessThanOrEqual(2_000_000);

        const full = streamed.render(80);
        const windowed = streamed.renderWindow(80, 0, full.length);
        expect(windowed.lines).toEqual(full);
        expect(windowed.totalLines).toBe(full.length);
      }
    }
  });

  test("keeps root list continuation chunks byte-identical for every streaming prefix", () => {
    const sources = [
      [
        "- parent one",
        "  continuation one",
        "  second continuation with additional wrapping words",
        "* **parent two** with generated content",
        "  `code continuation` with 中文 and emoji ✅"
      ].join("\n"),
      [
        "+ [ ] pending parent task",
        "  [x] completed continuation task",
        "- parent with *italic* and ~~strike~~",
        "  [official link](https://example.com) continuation"
      ].join("\n")
    ];

    for (const theme of [
      createTheme(false),
      createTheme(true, "dark"),
      createTheme(true, "light")
    ]) {
      for (const source of sources) {
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
      }
    }
  });

  test("keeps root ordered continuation chunks byte-identical for every streaming prefix", () => {
    const sources = [
      [
        "1. **first item** ordinary tail",
        "    continuation one with `code`",
        `    second continuation ${"with wrapping words ".repeat(6).trim()}`,
        "2. *second item* with ~~deleted text~~",
        "    [official link](https://example.com) continuation",
        "3. 中文 item ✅",
        "    final continuation"
      ].join("\n"),
      [
        "7) [ ] pending parent task",
        "    [x] completed continuation task",
        "7) repeated source marker",
        "    continuation is normalized to item eight",
        "7) final repeated marker",
        "    final continuation"
      ].join("\n"),
      [
        "98. item ninety eight",
        "    continuation 98",
        "98. item ninety nine after normalization",
        "    continuation 99",
        "98. item one hundred after normalization",
        "    continuation 100"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              widthState?: { characters: number };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingStableListMarkdown");
        expect(internal.renderedSegments[0]?.component.widthState?.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  test("keeps root ordered nested-list chunks byte-identical for every streaming prefix", () => {
    const sources = [
      [
        "1. **first parent** ordinary tail",
        "   - child one with `code`",
        `   * child two ${"with wrapping words ".repeat(6).trim()}`,
        "2. *second parent* with ~~deleted text~~",
        "   + [ ] pending child task",
        "3. 中文 parent ✅",
        "   - [x] completed child task"
      ].join("\n"),
      [
        "7) repeated source parent",
        "   - child seven",
        "7) repeated becomes eight",
        "   * child eight",
        "7) repeated becomes nine",
        "   + child nine"
      ].join("\n"),
      [
        "9. item nine",
        "   - child nine",
        "9. normalized item ten",
        "   - child ten",
        "9. normalized item eleven",
        "   - child eleven"
      ].join("\n"),
      [
        "99. item ninety-nine",
        "    - child ninety-nine",
        "99. normalized item one hundred",
        "    - child one hundred",
        "99. normalized item one hundred one",
        "    - child one hundred one"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              widthState?: { characters: number };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingStableListMarkdown");
        expect(internal.renderedSegments[0]?.component.widthState?.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  test("normalizes root ordered lists exactly like the whole Markdown renderer", () => {
    const sources = [
      [
        "1. **first item** ordinary tail",
        "1. `second item` with more words",
        "1. [ ] pending 中文 task ✅",
        "1. [x] completed task"
      ].join("\n"),
      [
        "7) starts from seven",
        "8) **continues at eight**",
        "9) final item wraps with additional generated words"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
      }
    }
  });

  test("keeps loose root ordered lists byte-identical for every streaming prefix", () => {
    const sources = [
      [
        "1. **first item** ordinary tail",
        "",
        `2. \`second item\` ${"with wrapping words ".repeat(8).trim()}`,
        "",
        "3. [ ] pending 中文 task ✅",
        "",
        "4. [x] completed task"
      ].join("\n"),
      [
        "7) starts from seven",
        "",
        "7) **repeated source marker normalizes to eight**",
        "",
        "7) final repeated marker becomes nine"
      ].join("\n"),
      [
        "9. item nine with generated output",
        "",
        "9. normalized item ten crosses marker width",
        "",
        "9. normalized item eleven with emoji ✅"
      ].join("\n"),
      `${[
        "99) item ninety-nine",
        "",
        "99) normalized item one hundred with 中文宽度",
        "",
        "99) normalized item one hundred one"
      ].join("\n")}\n\n`
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              separatorKind?: string;
              widthState?: { characters: number };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingStableListMarkdown");
        expect(internal.renderedSegments[0]?.component.separatorKind).toBe("blank");
        expect(internal.renderedSegments[0]?.component.widthState?.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  test("keeps unsupported loose root ordered lists on the original Markdown path", () => {
    for (const source of [
      "1. first\n\n2.",
      "1. first\n\n\n2. double blank",
      "1. first\n \n2. non-empty blank",
      "1. first\n\n2) mixed delimiter",
      "1. first\n\n- unordered transition",
      "1. first\n\n   - nested child",
      "1. first\n\n    continuation",
      "1. first\n\n# heading transition",
      "1. first\n\n2. **cross-line starts\ncloses here**",
      "1.  ambiguous spacing\n\n2. second",
      "999999999. first\n\n999999999. overflow",
      `1. item ${"x".repeat(100_000)}\n\n2. second`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      expect(component.render(80).length).toBeGreaterThan(0);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
    }
  });

  test("keeps non-flat root ordered lists on the original Markdown path", () => {
    for (const source of [
      "1.",
      "1. first\n2) mixed delimiter",
      "1. first\n- unordered transition",
      "999999999. first\n999999999. overflow",
      "1. first\n   continuation"
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      expect(component.render(80).length).toBeGreaterThan(0);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
    }
  });

  test("keeps unsupported root nested lists on the original Markdown path", () => {
    for (const source of [
      "- parent\n  -",
      "-  ambiguous parent spacing\n  - child",
      "- parent\n  -  ambiguous child spacing",
      "- parent\n   - wrong indent",
      "- parent\n    - deeper child",
      "- parent\n    continuation before child",
      "- parent\n  - child\n   continuation with wrong indent",
      "- parent\n  - child\n     continuation with deeper indent",
      "- parent\n  - child\n    1. ordered grandchild",
      "- parent\n  - child\n    # nested heading",
      "- parent\n  - child\n    > nested quote",
      "- parent\n  - child\n    **cross\n    line**",
      "- parent\n  1. ordered child",
      "- parent\n  - child\n- flat sibling",
      "- parent\n  - **cross\n    line**",
      "- parent\n  - # nested heading",
      `- parent\n  - child ${"x".repeat(100_000)}`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      expect(component.render(80).length).toBeGreaterThan(0);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
    }
  });

  test("keeps unsupported loose root nested lists on the original Markdown path", () => {
    for (const source of [
      "- parent\n\n   - child with wrong indent",
      "- parent\n \n  - child after a non-empty blank line",
      "- parent\n\n\n  - child after multiple blank lines",
      "- parent\n\n  1. ordered child",
      "1. ordered parent\n\n   - unordered child",
      "- parent\n\n  - child\n  - adjacent child",
      "- parent\n\n  - child\n    continuation",
      "- parent\n\n  - child\n\n    - grandchild",
      "- parent\n\n  - child\n\n- next parent without a child",
      "- parent\n\n  - # nested heading",
      "- parent\n\n  - <div>nested HTML</div>",
      "- **cross\n\n  line** child",
      "- parent\n\n  - **cross\n\n  line**",
      `- parent\n\n  - child ${"x".repeat(100_000)}`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      expect(component.render(80).length).toBeGreaterThan(0);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
    }
  });

  test("keeps unsupported root list continuations on the original Markdown path", () => {
    for (const source of [
      "- parent\n continuation with wrong indent",
      "- parent\n   continuation with deeper indent",
      "- parent\n  - nested child\n  mixed continuation",
      "1. ordered parent\n   ordered continuation",
      "- parent\n  continuation\n- flat sibling",
      "- parent\n  **cross\n  line**",
      "- parent\n  # nested heading",
      `- parent\n  continuation ${"x".repeat(100_000)}`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      expect(component.render(80).length).toBeGreaterThan(0);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
    }
  });

  test("keeps unsupported root ordered continuations on the original Markdown path", () => {
    for (const source of [
      "1. parent\n   continuation with wrong indent",
      "1. parent\n     continuation with deeper indent",
      "1.  ambiguous parent spacing\n    continuation",
      "1. parent\n    continuation\n2) mixed delimiter\n    continuation",
      "1. parent\n    continuation\n- unordered transition",
      "1. parent\n    - nested child",
      "1. parent\n    # nested heading",
      "1. parent\n    > nested quote",
      "1. **cross\n    line**",
      "1. parent\n\n    loose continuation",
      "1. parent\n    continuation\n2. next parent without continuation",
      "999999999. parent\n    continuation\n999999999. overflow\n    continuation",
      `1. parent\n    continuation ${"x".repeat(100_000)}`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      expect(component.render(80).length).toBeGreaterThan(0);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
    }
  });

  test("keeps unsupported root ordered nested lists on the original Markdown path", () => {
    for (const source of [
      "1. parent\n   - child\n2. final parent without child",
      "   - child before parent",
      "1. parent\n  - child with too little indent",
      "1. parent\n    - child with too much indent",
      "10. parent\n   - child using one-digit indent",
      "1.  ambiguous parent spacing\n   - child",
      "1. parent\n   -  ambiguous child spacing",
      "1. parent\n   1. ordered child",
      "1. parent\n   - child\n     - grandchild",
      "1. parent\n   - child\n     continuation",
      "1. parent\n   # nested heading",
      "1. parent\n   > nested quote",
      "1. parent\n   - **cross\n     line**",
      "1. parent\n\n   - loose child",
      "1. parent\n   - child\n2) mixed delimiter\n   - child",
      "1. parent\n   - child\n- unordered parent",
      "999999999. parent\n           - child\n999999999. overflow\n           - child",
      `1. parent\n   - child ${"x".repeat(100_000)}`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      expect(component.render(80).length).toBeGreaterThan(0);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
    }
  });

  test("avoids incremental setup for a restored large root nested list", () => {
    const chunks = Array.from(
      { length: 65 },
      (_, index) => `- parent ${index}\n  - nested child ${index}`
    );
    const restored = new RichMarkdown(chunks.join("\n"), 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(chunks[0]!, 1, createTheme(true));
    streamed.render(80);
    streamed.appendText(`\n${chunks.slice(1).join("\n")}`);
    streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");

    const replacement = chunks.map((chunk) => chunk.replaceAll("parent", "replacement"));
    streamed.setText(replacement.join("\n"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("avoids incremental setup for a restored large nested child continuation", () => {
    const chunks = Array.from(
      { length: 65 },
      (_, index) => [
        `- parent ${index}`,
        `  - nested child ${index}`,
        `    continuation ${index}`
      ].join("\n")
    );
    const restored = new RichMarkdown(chunks.join("\n"), 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(chunks[0]!, 1, createTheme(true));
    streamed.render(80);
    streamed.appendText(`\n${chunks.slice(1).join("\n")}`);
    streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");

    streamed.setText(chunks.map((chunk) => chunk.replace("parent", "replacement")).join("\n"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("avoids incremental setup for a restored large loose root nested list", () => {
    const chunks = Array.from(
      { length: 65 },
      (_, index) => `- parent ${index}\n\n  - nested child ${index}`
    );
    const restored = new RichMarkdown(chunks.join("\n\n"), 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(chunks[0]!, 1, createTheme(true));
    streamed.render(80);
    streamed.appendText(`\n\n${chunks.slice(1).join("\n\n")}`);
    streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{
        component: { constructor: { name: string }; separatorKind?: string };
      }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");
    expect(streamedInternal.renderedSegments[0]?.component.separatorKind).toBe("blank");

    streamed.setText(chunks.map((chunk) => chunk.replace("parent", "replacement")).join("\n\n"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("avoids incremental setup for a restored large loose root ordered list", () => {
    const items = Array.from(
      { length: 65 },
      (_, index) => `${index + 1}. **item ${index}** generated output`
    );
    const source = items.join("\n\n");
    const restored = new RichMarkdown(source, 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(items.slice(0, 2).join("\n\n"), 1, createTheme(true));
    streamed.render(80);
    streamed.appendText(`\n\n${items.slice(2).join("\n\n")}`);
    streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{
        component: { constructor: { name: string }; separatorKind?: string };
      }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");
    expect(streamedInternal.renderedSegments[0]?.component.separatorKind).toBe("blank");

    streamed.setText(source.replaceAll("generated", "replacement"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("avoids incremental setup for a restored large root continuation list", () => {
    const chunks = Array.from(
      { length: 65 },
      (_, index) => `- parent ${index}\n  continuation ${index}`
    );
    const restored = new RichMarkdown(chunks.join("\n"), 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(chunks[0]!, 1, createTheme(true));
    streamed.render(80);
    streamed.appendText(`\n${chunks.slice(1).join("\n")}`);
    streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");
  });

  test("avoids incremental setup for a restored large root ordered continuation list", () => {
    const chunks = Array.from(
      { length: 65 },
      (_, index) => `${index + 1}. item ${index}\n    continuation ${index}`
    );
    const restored = new RichMarkdown(chunks.join("\n"), 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(chunks[0]!, 1, createTheme(true));
    streamed.render(80);
    streamed.appendText(`\n${chunks.slice(1).join("\n")}`);
    streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");

    streamed.setText(chunks.map((chunk) => chunk.replace("item", "replacement")).join("\n"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("avoids incremental setup for a restored large root ordered nested list", () => {
    const chunks = Array.from(
      { length: 65 },
      (_, index) => {
        const marker = `${index + 1}.`;
        return `${marker} parent ${index}\n${" ".repeat(marker.length + 1)}- child ${index}`;
      }
    );
    const source = chunks.join("\n");
    const restored = new RichMarkdown(source, 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(chunks[0]!, 1, createTheme(true));
    streamed.render(80);
    streamed.appendText(`\n${chunks.slice(1).join("\n")}`);
    streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");

    streamed.setText(source.replaceAll("parent", "replacement"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
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

    expect(splitMarkdownSegments("    top-level indented code")).toEqual([
      { kind: "markdown", text: "    top-level indented code" }
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

  test("keeps contextual blank boundaries byte-identical to whole Markdown", () => {
    const sources = [
      "    top-level indented code",
      "paragraph\n\n    indented code",
      "- parent\n  - child\n\n    loose continuation",
      "1. first\n\n1. second",
      "- first\n\n- second",
      "paragraph\n\n> quoted block",
      "first paragraph\n\nsecond paragraph"
    ];

    expect(splitStreamingMarkdownSegments(sources[1]!)).toEqual([
      { kind: "markdown", text: sources[1]! }
    ]);
    expect(splitStreamingMarkdownSegments(sources[3]!)).toEqual([
      { kind: "markdown", text: sources[3]! }
    ]);
    expect(splitStreamingMarkdownSegments(sources[6]!)).toEqual([
      { kind: "markdown", text: "first paragraph" },
      { kind: "markdown", text: "second paragraph" }
    ]);

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
      }
    }
  });

  test("keeps full and windowed segment separators width-identical", () => {
    const component = new RichMarkdown("first paragraph\n\nsecond paragraph", 1, createTheme(false));
    const full = component.render(80);
    const windowed = component.renderWindow(80, 0, full.length);

    expect(windowed.lines).toEqual(full);
    expect(windowed.totalLines).toBe(full.length);
    expect(full.find((line) => line.trim() === "")).toBe(" ".repeat(80));
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

  test("keeps streaming TypeScript fences byte-identical while the closing fence arrives", () => {
    const source = [
      "```typescript",
      "const answer: number = 42;",
      "const matcher: RegExp = /answer+/g;",
      "const label: string = \"中文 ✅\";",
      `const longValue = \"${"wrapped".repeat(24)}\";`,
      "```"
    ].join("\n");

    for (const [colors, scheme] of [
      [false, "dark"],
      [true, "dark"],
      [true, "light"]
    ] as const) {
      const streamed = new RichMarkdown("", 1, createTheme(colors, scheme));
      const base = createTheme(colors, scheme);
      const fullHighlighter = new CodeHighlighter(colors, scheme);
      const fallbackTheme = {
        ...base,
        markdown: {
          ...base.markdown,
          highlightCode: (code: string, language?: string) => fullHighlighter.highlight(
            code,
            language === "typescript" || language === "ts" ? "tsx" : language
          )
        }
      };
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new RichMarkdown(prefix, 1, fallbackTheme);
        for (const width of [40, 60, 80, 100]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
    }
  });

  test("keeps blank-separated TypeScript blocks byte-identical while streaming", () => {
    const source = [
      "```typescript",
      "function first(value: number): number {",
      "  return value + 1;",
      "}",
      "",
      "interface User {",
      "  id: string;",
      "  name: string;",
      "}",
      "",
      "const user = {",
      "  id: \"1\",",
      "  name: \"Ada\"",
      "};",
      "```"
    ].join("\n");

    for (const scheme of ["dark", "light"] as const) {
      const streamed = new RichMarkdown("", 1, createTheme(true, scheme));
      const base = createTheme(true, scheme);
      const fullHighlighter = new CodeHighlighter(true, scheme);
      const fallbackTheme = {
        ...base,
        markdown: {
          ...base.markdown,
          highlightCode: (code: string, language?: string) => fullHighlighter.highlight(
            code,
            language === "typescript" || language === "ts" ? "tsx" : language
          )
        }
      };
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new RichMarkdown(prefix, 1, fallbackTheme);
        for (const width of [40, 80]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
    }
  });

  test("keeps adjacent top-level TypeScript blocks byte-identical while streaming", () => {
    const source = [
      "```typescript",
      "function first(value: number): number {",
      "  return value + 1;",
      "}",
      "interface User {",
      "  id: string;",
      "  name: string;",
      "}",
      "const user = {",
      "  id: \"1\",",
      "  name: \"Ada\"",
      "};",
      "```"
    ].join("\n");

    const streamed = new RichMarkdown("", 1, createTheme(true));
    const base = createTheme(true);
    const fullHighlighter = new CodeHighlighter(true);
    const fallbackTheme = {
      ...base,
      markdown: {
        ...base.markdown,
        highlightCode: (code: string, language?: string) => fullHighlighter.highlight(
          code,
          language === "typescript" || language === "ts" ? "tsx" : language
        )
      }
    };
    let prefix = "";
    for (const character of source) {
      prefix += character;
      streamed.appendText(character);
      const expected = new RichMarkdown(prefix, 1, fallbackTheme);
      for (const width of [40, 60, 80, 100]) {
        expect(streamed.render(width)).toEqual(expected.render(width));
      }
    }
  });

  test("keeps one still-open TypeScript function byte-identical while streaming", () => {
    const source = [
      "```typescript",
      "export async function generated(input: number): Promise<number> {",
      "  const doubled: number = input * 2;",
      "  // line-local comment",
      "  const label: string = \"中文 ✅\";",
      "  const matcher: RegExp = /value+/g;",
      "  await Promise.resolve(label);",
      "  return matcher.test(label) ? doubled : input;",
      "}",
      "```"
    ].join("\n");

    for (const [colors, scheme] of [
      [false, "dark"],
      [true, "dark"],
      [true, "light"]
    ] as const) {
      const theme = createTheme(colors, scheme);
      const streamed = new RichMarkdown("", 1, theme);
      const fullHighlighter = new CodeHighlighter(colors, scheme);
      const fallbackTheme = {
        ...theme,
        markdown: {
          ...theme.markdown,
          highlightCode: (code: string, language?: string) => fullHighlighter.highlight(
            code,
            language === "typescript" || language === "ts" ? "tsx" : language
          )
        }
      };
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new RichMarkdown(prefix, 1, fallbackTheme);
        for (const width of [40, 60, 80, 100]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
      const internal = streamed as unknown as {
        renderedSegments: Array<{ component: { constructor: { name: string } } }>;
      };
      expect(internal.renderedSegments[0]?.component.constructor.name)
        .toBe(colors ? "StreamingFencedCodeMarkdown" : "Markdown");
    }
  });

  test("uses incremental fence presentation only for bounded TypeScript streams", () => {
    const safe = new RichMarkdown([
      "~~~ts",
      "const first: number = 1;",
      "const second: number = 2;",
      "~~"
    ].join("\n"), 1, createTheme(true));
    safe.render(80);
    const safeInternal = safe as unknown as {
      renderedSegments: Array<{
        component: {
          constructor: { name: string };
          widthState?: { characters: number };
        };
      }>;
    };
    expect(safeInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingFencedCodeMarkdown");
    expect(safeInternal.renderedSegments[0]?.component.widthState?.characters)
      .toBeLessThanOrEqual(2_000_000);

    const blocks = new RichMarkdown([
      "```typescript",
      "function first(): number {",
      "  return 1;",
      "}",
      "",
      "function second(): number {",
      "  return 2;",
      "}"
    ].join("\n"), 1, createTheme(true));
    blocks.render(80);
    const blocksInternal = blocks as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(blocksInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingFencedCodeMarkdown");

    const singleOpenSource = [
      "```typescript",
      "function generated(input: number): number {",
      "  const doubled: number = input * 2;",
      "  return doubled;"
    ].join("\n");
    const coloredSingleOpen = new RichMarkdown(singleOpenSource, 1, createTheme(true));
    coloredSingleOpen.render(80);
    const coloredSingleOpenInternal = coloredSingleOpen as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(coloredSingleOpenInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingFencedCodeMarkdown");

    const plainSingleOpen = new RichMarkdown(singleOpenSource, 1, createTheme(false));
    plainSingleOpen.render(80);
    const plainSingleOpenInternal = plainSingleOpen as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(plainSingleOpenInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    for (const source of [
      "```typescript\nconst value = {\n  id: 1\n};",
      "```typescript\n/* open\nstill comment */",
      "```typescript\nconst value = `first\nsecond`;",
      "```tsx\nconst view = <Panel />;"
    ]) {
      const fallback = new RichMarkdown(source, 1, createTheme(true));
      fallback.render(80);
      const internal = fallback as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("keeps line-local Python fences byte-identical for every streaming prefix", () => {
    const sources = [
      [
        "```python",
        "value_0: int = 0  # generated output",
        "value_1: int = 1  # generated output",
        "value_2: int = 2  # generated output",
        "value_3: int = 3  # generated output"
      ].join("\n"),
      [
        "~~~py",
        "message: str = \"中文 ✅\"",
        "escaped = \"quote: \\\"ok\\\"\"",
        "items: list[int] = [1, 2, 3]",
        "mapping = {\"answer\": 42}",
        "def add(left: int, right: int) -> int:",
        "    return left + right",
        "print(add(1, 2))",
        "~~~"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const scheme of ["dark", "light"] as const) {
        const theme = createTheme(true, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              highlightState?: { sourceLines: string[] };
              widthState?: { characters: number };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingFencedCodeMarkdown");
        expect(internal.renderedSegments[0]?.component.highlightState?.sourceLines.length)
          .toBeGreaterThan(0);
        expect(internal.renderedSegments[0]?.component.widthState?.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  test("keeps no-color and unsafe Python fences on the original Markdown path", () => {
    const noColor = new RichMarkdown(
      "```python\nvalue: int = 1  # generated",
      1,
      createTheme(false)
    );
    noColor.render(80);
    const noColorInternal = noColor as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(noColorInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    for (const source of [
      "```python\ntext = \"\"\"first\nsecond\"\"\"",
      "```python\ntext = fr\"value {answer}\"",
      "```python\nvalue = 1 + \\\n  2",
      "```python\nvalues = (\n  1,\n)",
      "```python\nvalues = [1, 2}",
      "```python\n\tvalue = 1",
      `\`\`\`python\nvalue = "${"x".repeat(100_000)}"`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      component.render(80);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("avoids incremental setup for a restored large Python fence", () => {
    const lines = Array.from(
      { length: 65 },
      (_, index) => `value_${index}: int = ${index}  # generated output`
    );
    const source = `\`\`\`python\n${lines.join("\n")}`;
    const restored = new RichMarkdown(source, 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(
      `\`\`\`python\n${lines.slice(0, 2).join("\n")}`,
      1,
      createTheme(true)
    );
    streamed.render(80);
    streamed.appendText(`\n${lines.slice(2).join("\n")}`);
    streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingFencedCodeMarkdown");

    streamed.setText(source.replaceAll("generated", "replacement"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("keeps simple Python f-string fences byte-identical for every streaming prefix", () => {
    const sources = [
      [
        "```python",
        "value = f\"generated {index}\"  # output",
        "message = f\"中文 {value} ✅\"",
        "path = f\"{root.name}/{name}.txt\""
      ].join("\n"),
      [
        "~~~py",
        "formatted = f\"{value:.2f}\"",
        "converted = f\"value={value!r}\"",
        "literal = f\"{{value}} = {value}\"",
        "single = f'item {index}'",
        "escaped = f\"quote: \\\"{label}\\\"\"",
        "multiple = f\"{left} + {right} = {total}\"",
        "plain = f\"no replacement\"",
        "~~~"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              highlightState?: { sourceLines: string[] };
              widthState?: { characters: number };
            };
          }>;
        };
        if (colors) {
          expect(internal.renderedSegments[0]?.component.constructor.name)
            .toBe("StreamingFencedCodeMarkdown");
          expect(internal.renderedSegments[0]?.component.highlightState?.sourceLines.length)
            .toBeGreaterThan(0);
          expect(internal.renderedSegments[0]?.component.widthState?.characters)
            .toBeLessThanOrEqual(2_000_000);
        } else {
          expect(internal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
        }
      }
    }
  });

  test("keeps complex Python f-strings on the original Markdown path", () => {
    for (const source of [
      "```python\ntext = fr\"value {answer}\"",
      "```python\ntext = rf'value {answer}'",
      "```python\ntext = f\"\"\"value {answer}\"\"\"",
      "```python\ntext = f\"{value:{width}}\"",
      "```python\ntext = f\"{value + 1}\"",
      "```python\ntext = f\"{format(value)}\"",
      "```python\ntext = f\"{mapping[key]}\"",
      "```python\ntext = f\"{value=}\"",
      "```python\ntext = f\"{mapping['key']}\"",
      "```python\ntext = f\"{value\"",
      "```python\ntext = f\"value }\"",
      "```python\ntext = f\"{path\\name}\"",
      "```python\n\ttext = f\"value {answer}\""
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      component.render(80);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  function expectJsonFenceByteIdentical(quoted: boolean): void {
    const sourcePrefix = quoted ? "> " : "";
    const sources = [
      [
        `${sourcePrefix}\`\`\`json`,
        `${sourcePrefix}{`,
        `${sourcePrefix}  "name": "Ada",`,
        `${sourcePrefix}  "count": 42,`,
        `${sourcePrefix}  "active": true,`,
        `${sourcePrefix}  "nothing": null,`,
        `${sourcePrefix}  "nested": {"id": 1, "items": [1, 2, null]},`,
        `${sourcePrefix}  "escaped": "quote: \\" slash: \\\\ unicode: \\u4E2D",`,
        `${sourcePrefix}  "text": "中文 ✅",`,
        `${sourcePrefix}  "number": -1.25e+4`,
        `${sourcePrefix}}`,
        `${sourcePrefix}\`\`\``
      ].join("\n"),
      [
        `${sourcePrefix}~~~json`,
        `${sourcePrefix}[`,
        `${sourcePrefix}  {"id": 1, "name": "Ada"},`,
        `${sourcePrefix}  [1, 2, 3],`,
        `${sourcePrefix}  false,`,
        `${sourcePrefix}  "final value"`,
        `${sourcePrefix}]`
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              fence?: { lineContexts?: string[] };
              highlightState?: { lineContexts?: string[]; sourceLines: string[] };
              widthState?: { characters: number };
            };
          }>;
        };
        const component = internal.renderedSegments[0]?.component;
        if (quoted) {
          expect(component?.constructor.name).toBe("StreamingQuotedFencedCodeMarkdown");
          const expectedContext = source.split("\n")[1]?.slice(sourcePrefix.length).trim();
          expect(component?.fence?.lineContexts).toContain(expectedContext);
        } else if (colors) {
          expect(component?.constructor.name).toBe("StreamingFencedCodeMarkdown");
          expect(component?.highlightState?.sourceLines.length).toBeGreaterThan(0);
          expect(component?.highlightState?.lineContexts).toBeDefined();
          expect(component?.widthState?.characters).toBeLessThanOrEqual(2_000_000);
        } else {
          expect(component).toBeInstanceOf(Markdown);
        }
      }
    }
  }

  test("keeps strict root JSON fences byte-identical for every streaming prefix", () => {
    expectJsonFenceByteIdentical(false);
  });

  test("keeps strict quoted JSON fences byte-identical for every streaming prefix", () => {
    expectJsonFenceByteIdentical(true);
  });

  function expectNestedJsonFenceByteIdentical(quoted: boolean): void {
    const sourcePrefix = quoted ? "> " : "";
    const sources = [
      [
        `${sourcePrefix}\`\`\`json`,
        `${sourcePrefix}{`,
        `${sourcePrefix}  "profile": {`,
        `${sourcePrefix}    "name": "中文 ✅",`,
        `${sourcePrefix}    "count": -1.25e+4,`,
        `${sourcePrefix}    "active": true,`,
        `${sourcePrefix}  },`,
        `${sourcePrefix}  "items": [`,
        `${sourcePrefix}    1,`,
        `${sourcePrefix}    {"id": 2, "value": null},`,
        `${sourcePrefix}    "escaped \\u4E2D",`,
        `${sourcePrefix}  ],`,
        `${sourcePrefix}  "tail": false`,
        `${sourcePrefix}}`,
        `${sourcePrefix}\`\`\``
      ].join("\n"),
      [
        `${sourcePrefix}~~~json`,
        `${sourcePrefix}[`,
        `${sourcePrefix}  {`,
        `${sourcePrefix}    "id": 1,`,
        `${sourcePrefix}  },`,
        `${sourcePrefix}  [`,
        `${sourcePrefix}    true,`,
        `${sourcePrefix}    null,`,
        `${sourcePrefix}  ],`,
        `${sourcePrefix}]`
      ].join("\n"),
      [
        `${sourcePrefix}\`\`\`json`,
        `${sourcePrefix}{`,
        `${sourcePrefix}  "last": {`,
        `${sourcePrefix}    "id": 1`,
        `${sourcePrefix}  }`,
        `${sourcePrefix}}`
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              fence?: { lineContexts?: string[] };
              rejectedWidths?: Set<number>;
            };
          }>;
        };
        const component = internal.renderedSegments[0]?.component;
        if (quoted) {
          expect(component?.constructor.name).toBe("StreamingQuotedFencedCodeMarkdown");
          expect(component?.fence?.lineContexts).toContain("{");
          if (source.includes("[")) expect(component?.fence?.lineContexts).toContain("[");
          expect(component?.rejectedWidths?.size).toBe(0);
        } else if (colors) {
          expect(component?.constructor.name).toBe("StreamingFencedCodeMarkdown");
          expect(component?.fence?.lineContexts).toContain("{");
          if (source.includes("[")) expect(component?.fence?.lineContexts).toContain("[");
          expect(component?.rejectedWidths?.size).toBe(0);
        } else {
          expect(component).toBeInstanceOf(Markdown);
        }
      }
    }
  }

  test("keeps bounded root nested JSON fences byte-identical for every prefix", () => {
    expectNestedJsonFenceByteIdentical(false);
  });

  test("keeps bounded quoted nested JSON fences byte-identical for every prefix", () => {
    expectNestedJsonFenceByteIdentical(true);
  });

  test("keeps unsafe JSON fences on the original Markdown path", () => {
    for (const source of [
      "```json\n{\n  // comment\n}",
      "```json\n{\n  /* comment */\n}",
      "```json\n{\n  'name': 'Ada'\n}",
      "```json\n{\n  name: \"Ada\"\n}",
      "```json\n{\n  \"name\": NaN\n}",
      "```json\n{\n  \"name\": Infinity\n}",
      "```json\n{\n  \"name\": \"bad \\x escape\"\n}",
      "```json\n{\n  \"nested\": {\n  },\n}",
      "```json\n{\n  \"items\": [\n  ],\n}",
      "```json\n{\n  \"nested\": {\n    \"deeper\": {\n      \"id\": 1\n    }\n  }\n}",
      "```json\n{\n  \"nested\": {\n    \"id\": 1\n  ]\n}",
      "```json\n{\n  \"name\": \"Ada\"\n]",
      "```json\n\t{\"name\": \"Ada\"}",
      "```json5\n{\"name\": \"Ada\"}",
      "> ```json\n> {\n>   // comment\n> }",
      "> ```json\n> {\n>   \"nested\": {\n>   },\n> }",
      "> ```json\n> {\n>   \"nested\": {\n>     \"deeper\": [\n>       1\n>     ]\n>   }\n> }",
      "> ```json5\n> {\"name\": \"Ada\"}",
      "> > ```json\n> > {\n> >   \"name\": \"Ada\"\n> > }",
      ">```json\n> {\n>   \"name\": \"Ada\"\n> }",
      `\`\`\`json\n{"value": "${"x".repeat(100_000)}"}`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      component.render(80);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
    }
  });

  test("keeps JSON streaming owners through growth and skips restored large setup", () => {
    for (const quoted of [false, true]) {
      const sourcePrefix = quoted ? "> " : "";
      const lines = Array.from(
        { length: 90 },
        (_, index) => `${sourcePrefix}  "value_${index}": {"index": ${index}, "active": true},`
      );
      const source = [
        `${sourcePrefix}\`\`\`json`,
        `${sourcePrefix}{`,
        ...lines
      ].join("\n");
      const restored = new RichMarkdown(source, 1, createTheme(true));
      restored.render(80);
      const restoredInternal = restored as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

      const streamed = new RichMarkdown(
        [
          `${sourcePrefix}\`\`\`json`,
          `${sourcePrefix}{`,
          ...lines.slice(0, 2)
        ].join("\n"),
        1,
        createTheme(true)
      );
      streamed.render(80);
      streamed.appendText(`\n${lines.slice(2).join("\n")}`);
      streamed.render(80);
      const expectedName = quoted
        ? "StreamingQuotedFencedCodeMarkdown"
        : "StreamingFencedCodeMarkdown";
      const streamedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: { constructor: { name: string } } }>;
      };
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name).toBe(expectedName);

      const partial = `${sourcePrefix}  "partial": {"value": -1.25e+4}`;
      let expectedSource = `${source}\n`;
      streamed.appendText("\n");
      for (const character of partial) {
        expectedSource += character;
        streamed.appendText(character);
        expect(streamed.render(80)).toEqual(
          new Markdown(
            withoutBoundaryBlankLines(expectedSource),
            1,
            0,
            createTheme(true).markdown
          ).render(80)
        );
        expect(streamedInternal.renderedSegments[0]?.component.constructor.name).toBe(expectedName);
      }

      streamed.setText(source.replaceAll("active", "replacement"));
      streamed.render(80);
      const replacedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("keeps nested JSON owners through growth and rejects unsafe replacement", () => {
    for (const quoted of [false, true]) {
      const sourcePrefix = quoted ? "> " : "";
      const blocks = Array.from({ length: 30 }, (_, index) => [
        `${sourcePrefix}  "value_${index}": {`,
        `${sourcePrefix}    "index": ${index}, "active": true,`,
        `${sourcePrefix}  },`
      ]).flat();
      const source = [
        `${sourcePrefix}\`\`\`json`,
        `${sourcePrefix}{`,
        ...blocks
      ].join("\n");
      const restored = new RichMarkdown(source, 1, createTheme(true));
      restored.render(80);
      const restoredInternal = restored as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

      const streamed = new RichMarkdown(
        [
          `${sourcePrefix}\`\`\`json`,
          `${sourcePrefix}{`,
          ...blocks.slice(0, 3)
        ].join("\n"),
        1,
        createTheme(true)
      );
      streamed.render(80);
      streamed.appendText(`\n${blocks.slice(3).join("\n")}`);
      streamed.render(80);
      const expectedName = quoted
        ? "StreamingQuotedFencedCodeMarkdown"
        : "StreamingFencedCodeMarkdown";
      const streamedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: { constructor: { name: string } } }>;
      };
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name).toBe(expectedName);

      const partial = [
        `${sourcePrefix}  "tail": [`,
        `${sourcePrefix}    "中文 ✅",`,
        `${sourcePrefix}  ],`
      ].join("\n");
      let expectedSource = `${source}\n`;
      streamed.appendText("\n");
      for (const character of partial) {
        expectedSource += character;
        streamed.appendText(character);
        expect(streamed.render(80)).toEqual(
          new Markdown(
            withoutBoundaryBlankLines(expectedSource),
            1,
            0,
            createTheme(true).markdown
          ).render(80)
        );
        expect(streamedInternal.renderedSegments[0]?.component.constructor.name).toBe(expectedName);
      }

      streamed.setText([
        `${sourcePrefix}\`\`\`json`,
        `${sourcePrefix}{`,
        `${sourcePrefix}  "empty": {`,
        `${sourcePrefix}  },`,
        `${sourcePrefix}}`
      ].join("\n"));
      streamed.render(80);
      const replacedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  function expectBashFenceByteIdentical(quoted: boolean): void {
    const sourcePrefix = quoted ? "> " : "";
    const sources = [
      [
        `${sourcePrefix}\`\`\`bash`,
        `${sourcePrefix}echo "generated value" # output`,
        `${sourcePrefix}printf "%s\\n" "value"`,
        `${sourcePrefix}export NAME="中文 ✅"`,
        `${sourcePrefix}cd /tmp && pwd`,
        `${sourcePrefix}test -f package.json || echo "missing"`,
        `${sourcePrefix}echo 'single quoted value'`,
        `${sourcePrefix}echo "escaped \\"quote\\""`,
        `${sourcePrefix}echo plain\\ value > output.txt`,
        `${sourcePrefix}echo value#literal`,
        `${sourcePrefix}\`\`\``
      ].join("\n"),
      [
        `${sourcePrefix}~~~sh`,
        `${sourcePrefix}printf "%s" "first"; echo "second"`,
        `${sourcePrefix}cd ./packages/zcode-tui < input.txt`,
        `${sourcePrefix}echo complete &`
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              fence?: { language: string };
              highlightState?: { sourceLines: string[] };
              widthState?: { characters: number };
            };
          }>;
        };
        const component = internal.renderedSegments[0]?.component;
        if (quoted) {
          expect(component?.constructor.name).toBe("StreamingQuotedFencedCodeMarkdown");
        } else if (colors) {
          expect(component?.constructor.name).toBe("StreamingFencedCodeMarkdown");
          expect(["bash", "sh"]).toContain(component?.fence?.language.toLowerCase() ?? "");
          expect(component?.highlightState?.sourceLines.length).toBeGreaterThan(0);
          expect(component?.widthState?.characters).toBeLessThanOrEqual(2_000_000);
        } else {
          expect(component).toBeInstanceOf(Markdown);
        }
      }
    }
  }

  test("keeps strict root Bash fences byte-identical for every streaming prefix", () => {
    expectBashFenceByteIdentical(false);
  });

  test("keeps strict quoted Bash fences byte-identical for every streaming prefix", () => {
    expectBashFenceByteIdentical(true);
  });

  test("keeps unsafe Bash fences on the original Markdown path", () => {
    for (const source of [
      "```bash\ncat <<EOF\nvalue\nEOF",
      "```bash\ncat <<< \"value\"",
      "```bash\necho `uname -a`",
      "```bash\necho $(uname -a)",
      "```bash\necho ${HOME}",
      "```bash\ncat <(printf value)",
      "```bash\ncat >(consume)",
      "```bash\necho value \\\ncontinued",
      "```bash\necho \"open quote\ncontinued\"",
      "```bash\necho value#literal \"open quote\ncontinued\"",
      "```bash\nfunction build() {\n  echo value\n}",
      "```bash\nif test -f file; then\n  echo value\nfi",
      "```bash\necho value |\nconsume",
      "```bash\necho value && # wait\nconsume",
      "```bash\nvalues=(one two)",
      "```bash\n[ -f package.json ] && echo value",
      "```bash\n\techo value",
      "```zsh\necho value",
      "```fish\necho value",
      "> ```bash\n> echo ${HOME}",
      "> > ```bash\n> > echo value",
      ">```bash\n> echo value",
      `\`\`\`bash\necho "${"x".repeat(100_000)}"`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      component.render(80);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
    }
  });

  test("keeps Bash streaming owners through growth and skips restored large setup", () => {
    for (const quoted of [false, true]) {
      const sourcePrefix = quoted ? "> " : "";
      const lines = Array.from(
        { length: 90 },
        (_, index) => `${sourcePrefix}echo "generated value_${index}" # output`
      );
      const source = [`${sourcePrefix}\`\`\`bash`, ...lines].join("\n");
      const restored = new RichMarkdown(source, 1, createTheme(true));
      restored.render(80);
      const restoredInternal = restored as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

      const theme = createTheme(true);
      const streamed = new RichMarkdown(
        [`${sourcePrefix}\`\`\`bash`, ...lines.slice(0, 2)].join("\n"),
        1,
        theme
      );
      streamed.render(80);
      streamed.appendText(`\n${lines.slice(2).join("\n")}`);
      streamed.render(80);
      const expectedName = quoted
        ? "StreamingQuotedFencedCodeMarkdown"
        : "StreamingFencedCodeMarkdown";
      const streamedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: { constructor: { name: string } } }>;
      };
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name).toBe(expectedName);

      const partial = `${sourcePrefix}echo "partial value"`;
      let expectedSource = `${source}\n`;
      streamed.appendText("\n");
      for (const character of partial) {
        expectedSource += character;
        streamed.appendText(character);
        expect(streamed.render(80)).toEqual(
          new Markdown(
            withoutBoundaryBlankLines(expectedSource),
            1,
            0,
            theme.markdown
          ).render(80)
        );
        expect(streamedInternal.renderedSegments[0]?.component.constructor.name).toBe(expectedName);
      }

      streamed.setText(source.replaceAll("generated", "replacement"));
      streamed.render(80);
      const replacedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("keeps line-local JavaScript fences byte-identical for every streaming prefix", () => {
    const sources = [
      [
        "```javascript",
        "const answer = 42; // generated output",
        "let label = \"中文 ✅\";",
        "const escaped = \"quote: \\\"ok\\\"\";",
        "const items = [1, 2, 3];",
        "const mapping = { answer: 42 };"
      ].join("\n"),
      [
        "~~~js",
        "const doubled = (value) => value * 2;",
        "const matched = /hello\\s+world/iu.test(label);",
        "const ratio = total / Math.max(count, 1);",
        "const optional = payload?.value ?? \"fallback\";",
        `const longValue = "${"wrapped words ".repeat(12).trim()}";`,
        "~~~"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              fence?: { language: string };
              highlightState?: { sourceLines: string[] };
              widthState?: { characters: number };
            };
          }>;
        };
        if (colors) {
          expect(internal.renderedSegments[0]?.component.constructor.name)
            .toBe("StreamingFencedCodeMarkdown");
          const language = internal.renderedSegments[0]?.component.fence?.language.toLowerCase();
          expect(language).toBeDefined();
          expect(["js", "javascript"]).toContain(language!);
          expect(internal.renderedSegments[0]?.component.highlightState?.sourceLines.length)
            .toBeGreaterThan(0);
          expect(internal.renderedSegments[0]?.component.widthState?.characters)
            .toBeLessThanOrEqual(2_000_000);
        } else {
          expect(internal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
        }
      }
    }
  });

  function expectJavaScriptFunctionFenceByteIdentical(
    quoted: boolean,
    nestedIf = false
  ): void {
    const sourcePrefix = quoted ? "> " : "";
    const nestedSources = [
      [
        `${sourcePrefix}\`\`\`javascript`,
        `${sourcePrefix}export async function generated(input) {`,
        `${sourcePrefix}  const matcher = /value+/g;`,
        `${sourcePrefix}  if (matcher.test(input)) {`,
        `${sourcePrefix}    await Promise.resolve(input);`,
        `${sourcePrefix}    return "中文 ✅";`,
        `${sourcePrefix}  }`,
        `${sourcePrefix}  return input;`,
        `${sourcePrefix}}`,
        `${sourcePrefix}function next(input) {`,
        `${sourcePrefix}  if (!input) {`,
        `${sourcePrefix}    return 0;`,
        `${sourcePrefix}  }`,
        `${sourcePrefix}  return input + 1;`,
        `${sourcePrefix}}`,
        `${sourcePrefix}\`\`\``
      ].join("\n"),
      [
        `${sourcePrefix}~~~js`,
        `${sourcePrefix}function wrapped(input) {`,
        `${sourcePrefix}  if (input > 0) {`,
        `${sourcePrefix}    const message = "${"wrapped words ".repeat(12).trim()}";`,
        `${sourcePrefix}    return message;`,
        `${sourcePrefix}  }`
      ].join("\n")
    ];
    const sources = nestedIf ? nestedSources : [
      [
        `${sourcePrefix}\`\`\`javascript`,
        `${sourcePrefix}function generated(input) {`,
        `${sourcePrefix}  const doubled = input * 2;`,
        `${sourcePrefix}  // generated comment`,
        `${sourcePrefix}  const label = "中文 ✅";`,
        `${sourcePrefix}  const matcher = /value+/g;`,
        `${sourcePrefix}  return matcher.test(label) ? doubled : input;`,
        `${sourcePrefix}}`,
        `${sourcePrefix}export async function next(input) {`,
        `${sourcePrefix}  await Promise.resolve(input);`,
        `${sourcePrefix}  return input + 1;`,
        `${sourcePrefix}}`,
        `${sourcePrefix}\`\`\``
      ].join("\n"),
      [
        `${sourcePrefix}~~~js`,
        `${sourcePrefix}function wrapped(input) {`,
        `${sourcePrefix}  const message = "${"wrapped words ".repeat(12).trim()}";`,
        `${sourcePrefix}  return message || input;`,
        `${sourcePrefix}}`
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              highlightState?: { sourceLines: string[] };
              widthState?: { body?: { characters: number }; characters?: number };
            };
          }>;
        };
        const component = internal.renderedSegments[0]?.component;
        if (quoted) {
          expect(component?.constructor.name).toBe("StreamingQuotedFencedCodeMarkdown");
          expect(component?.widthState?.body?.characters).toBeLessThanOrEqual(2_000_000);
        } else if (colors) {
          expect(component?.constructor.name).toBe("StreamingFencedCodeMarkdown");
          expect(component?.highlightState?.sourceLines.length).toBeGreaterThan(0);
          expect(component?.widthState?.characters).toBeLessThanOrEqual(2_000_000);
        } else {
          expect(component).toBeInstanceOf(Markdown);
        }
      }
    }
  }

  test("keeps simple root JavaScript function fences byte-identical for every prefix", () => {
    expectJavaScriptFunctionFenceByteIdentical(false);
  });

  test("keeps simple quoted JavaScript function fences byte-identical for every prefix", () => {
    expectJavaScriptFunctionFenceByteIdentical(true);
  });

  test("keeps nested-if root JavaScript function fences byte-identical for every prefix", () => {
    expectJavaScriptFunctionFenceByteIdentical(false, true);
  });

  test("keeps nested-if quoted JavaScript function fences byte-identical for every prefix", () => {
    expectJavaScriptFunctionFenceByteIdentical(true, true);
  });

  test("keeps unsafe JavaScript fences on the original Markdown path", () => {
    for (const source of [
      "```javascript\nconst value = `first\nsecond`;\nconst tail = 1;",
      "```javascript\n/* open\nstill comment */\nconst tail = 1;",
      "```javascript\nconst value = {\n  id: 1\n};",
      "```javascript\nfunction empty() {\n}",
      "```javascript\nfunction blank() {\n\n  return 1;\n}",
      "```javascript\nfunction value(\n  input\n) {\n  return input;\n}",
      "```javascript\nfunction emptyNested(input) {\n  if (input) {\n  }\n  return input;\n}",
      "```javascript\nfunction secondNested(input) {\n  if (input) {\n    return input;\n  }\n  if (!input) {\n    return 0;\n  }\n}",
      "```javascript\nfunction deeper(input) {\n  if (input) {\n    if (input.value) {\n      return input.value;\n    }\n  }\n}",
      "```javascript\nfunction alternative(input) {\n  if (input) {\n    return input;\n  } else {\n    return 0;\n  }\n}",
      "```javascript\nfunction loop(input) {\n  while (input) {\n    input -= 1;\n  }\n}",
      "```javascript\nfunction condition(input) {\n  if (\n    input\n  ) {\n    return input;\n  }\n}",
      "```javascript\nconst value = (input) => {\n  return input;\n}",
      "```javascript\nclass Value {\n  method() { return 1; }\n}",
      "```javascript\nconst value = 1 + \\\n  2;",
      "```javascript\n\tconst value = 1;\nconst tail = 2;",
      "```javascript\nconst view = <Panel />;\nconst tail = 1;",
      "```jsx\nconst view = <Panel />;",
      "```mjs\nconst value = 1;\nconsole.log(value);",
      "```cjs\nconst value = 1;\nmodule.exports = value;",
      "> ```javascript\n> function value(input) {\n>   if (input) {\n>     return input;\n>   } else {\n>     return 0;\n>   }\n> }",
      "> > ```javascript\n> > function value(input) {\n> >   return input;\n> > }",
      `\`\`\`javascript\nconst first = "${"x".repeat(100_000)}";\nconst second = 2;`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      component.render(80);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("keeps quoted line-local TypeScript fences byte-identical for every prefix", () => {
    const sources = [
      [
        "> ```typescript",
        "> const answer: number = 42; // generated",
        "> const label: string = \"中文 ✅\";",
        "> const row = { answer: 42 };",
        `> const longValue = "${"wrapped words ".repeat(12).trim()}";`,
        "> ```"
      ].join("\n"),
      [
        "> ~~~ts",
        "> type Row = { value: number };",
        "> const first: Row = { value: 1 };",
        "> const second: Row = { value: 2 }; // open fence"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              widthState?: { body: { characters: number } };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingQuotedFencedCodeMarkdown");
        expect(internal.renderedSegments[0]?.component.widthState?.body.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  test("keeps depth-one quoted TypeScript functions byte-identical for every prefix", () => {
    const sources = [
      [
        "> ```typescript",
        "> export async function generated<T>(input: T): Promise<T> {",
        ">   const label: string = \"中文 ✅\";",
        ">   const matcher: RegExp = /value+/g;",
        ">   await Promise.resolve(label);",
        ">   return matcher.test(label) ? input : input;",
        "> }",
        "> function next(input: number): number {",
        ">   return input + 1;",
        "> }",
        "> ```"
      ].join("\n"),
      [
        "> ~~~ts",
        "> function wrapped(input: number): number {",
        ">   if (input > 0) {",
        `>     const message: string = "${"wrapped words ".repeat(12).trim()}";`,
        ">     return input;",
        ">   }",
        ">   return 0;"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let activated = false;
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
          const during = streamed as unknown as {
            renderedSegments: Array<{ component: { constructor: { name: string } } }>;
          };
          const componentName = during.renderedSegments[0]?.component.constructor.name;
          if (componentName === "StreamingQuotedFencedCodeMarkdown") activated = true;
          if (activated) expect(componentName).toBe("StreamingQuotedFencedCodeMarkdown");
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              fence?: { quoteDepth: number };
              rejectedWidths?: Set<number>;
              widthState?: { body: { characters: number } };
            };
          }>;
        };
        const component = internal.renderedSegments[0]?.component;
        expect(component?.constructor.name).toBe("StreamingQuotedFencedCodeMarkdown");
        expect(component?.fence?.quoteDepth).toBe(1);
        expect(component?.rejectedWidths?.size).toBe(0);
        expect(component?.widthState?.body.characters).toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  test("keeps quoted TypeScript function owners through growth and unsafe replacement", () => {
    const blocks = Array.from({ length: 30 }, (_, index) => [
      `> function generated_${index}(input: number): number {`,
      `>   return input + ${index};`,
      "> }"
    ]).flat();
    const source = ["> ```typescript", ...blocks].join("\n");
    const restored = new RichMarkdown(source, 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const theme = createTheme(true);
    const streamed = new RichMarkdown(
      ["> ```typescript", ...blocks.slice(0, 3)].join("\n"),
      1,
      theme
    );
    streamed.render(80);
    streamed.appendText(`\n${blocks.slice(3).join("\n")}`);
    streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingQuotedFencedCodeMarkdown");

    const partial = [
      "> function tail(input: number): number {",
      ">   return input;",
      "> }"
    ].join("\n");
    let expectedSource = `${source}\n`;
    streamed.appendText("\n");
    for (const character of partial) {
      expectedSource += character;
      streamed.appendText(character);
      expect(streamed.render(80)).toEqual(
        new Markdown(
          withoutBoundaryBlankLines(expectedSource),
          1,
          0,
          theme.markdown
        ).render(80)
      );
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingQuotedFencedCodeMarkdown");
    }

    streamed.setText([
      "> ```typescript",
      "> function unsafe(input: number): number {",
      ">   if (input > 0) {",
      ">     return input;",
      ">   } else {",
      ">     return 0;",
      ">   }",
      "> }"
    ].join("\n"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("keeps depth-two quoted TypeScript fences byte-identical for every prefix", () => {
    const sources = [
      [
        "> > ```typescript",
        "> > const answer: number = 42; // generated",
        "> > const label: string = \"中文 ✅\";",
        "> > const row = { answer: 42 };",
        `> > const longValue = "${"wrapped words ".repeat(12).trim()}";`,
        "> > ```"
      ].join("\n"),
      [
        "> > ~~~ts",
        "> > type Row = { value: number };",
        "> > const first: Row = { value: 1 };",
        "> > const second: Row = { value: 2 }; // open fence"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              fence?: { quoteDepth: number };
              widthState?: { body: { characters: number } };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingQuotedFencedCodeMarkdown");
        expect(internal.renderedSegments[0]?.component.fence?.quoteDepth).toBe(2);
        expect(internal.renderedSegments[0]?.component.widthState?.body.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  test("keeps quoted line-local Python fences byte-identical for every prefix", () => {
    const sources = [
      [
        "> ```python",
        "> value: int = 1  # generated output",
        "> label: str = \"中文 ✅\"",
        "> escaped = \"quote: \\\"ok\\\"\"",
        "> items: list[int] = [1, 2, 3]",
        "> mapping = {\"answer\": 42}",
        "> ```"
      ].join("\n"),
      [
        "> ~~~py",
        "> def add(left: int, right: int) -> int:",
        ">     return left + right",
        "> print(add(1, 2))  # open fence"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              fence?: { language: string; quoteDepth: number };
              widthState?: { body: { characters: number } };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingQuotedFencedCodeMarkdown");
        expect(internal.renderedSegments[0]?.component.fence?.quoteDepth).toBe(1);
        const language = internal.renderedSegments[0]?.component.fence?.language.toLowerCase();
        expect(language).toBeDefined();
        expect(["py", "python"]).toContain(language!);
        expect(internal.renderedSegments[0]?.component.widthState?.body.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  test("keeps quoted simple Python f-strings byte-identical for every prefix", () => {
    const sources = [
      [
        "> ```python",
        "> value = f\"generated {index}\"  # output",
        "> message = f\"中文 {value} ✅\"",
        "> path = f\"{root.name}/{name}.txt\"",
        "> ```"
      ].join("\n"),
      [
        "> ~~~py",
        "> formatted = f\"{value:.2f}\"",
        "> converted = f\"value={value!r}\"",
        "> literal = f\"{{value}} = {value}\"",
        "> single = f'item {index}'",
        "> escaped = f\"quote: \\\"{label}\\\"\"",
        "> multiple = f\"{left} + {right} = {total}\""
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              fence?: { language: string; quoteDepth: number };
              widthState?: { body: { characters: number } };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingQuotedFencedCodeMarkdown");
        expect(internal.renderedSegments[0]?.component.fence?.quoteDepth).toBe(1);
        const language = internal.renderedSegments[0]?.component.fence?.language.toLowerCase();
        expect(language).toBeDefined();
        expect(["py", "python"]).toContain(language!);
        expect(internal.renderedSegments[0]?.component.widthState?.body.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  test("keeps quoted line-local JavaScript fences byte-identical for every prefix", () => {
    const sources = [
      [
        "> ```javascript",
        "> const answer = 42; // generated output",
        "> let label = \"中文 ✅\";",
        "> const escaped = \"quote: \\\"ok\\\"\";",
        "> const items = [1, 2, 3];",
        "> const mapping = { answer: 42 };",
        "> ```"
      ].join("\n"),
      [
        "> ~~~js",
        "> const doubled = (value) => value * 2;",
        "> const matched = /hello\\s+world/iu.test(label);",
        "> const ratio = total / Math.max(count, 1);",
        "> const optional = payload?.value ?? \"fallback\";",
        `> const longValue = "${"wrapped words ".repeat(12).trim()}";`
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              fence?: { language: string; quoteDepth: number };
              widthState?: { body: { characters: number } };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingQuotedFencedCodeMarkdown");
        expect(internal.renderedSegments[0]?.component.fence?.quoteDepth).toBe(1);
        const language = internal.renderedSegments[0]?.component.fence?.language.toLowerCase();
        expect(language).toBeDefined();
        expect(["js", "javascript"]).toContain(language!);
        expect(internal.renderedSegments[0]?.component.widthState?.body.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  function expectDeepQuotedFenceByteIdentical(
    depth: 3 | 4,
    closed: boolean,
    themes: ReadonlyArray<readonly [boolean, "dark" | "light"]> = [
      [false, "dark"],
      [true, "dark"],
      [true, "light"]
    ]
  ): void {
    const quote = "> ".repeat(depth);
    const source = closed
      ? [
        `${quote}\`\`\`typescript`,
        `${quote}const answer: number = 42; // generated`,
        `${quote}const label: string = "中文 ✅";`,
        `${quote}const row = { answer: 42 };`,
        `${quote}const longValue = "${"wrapped words ".repeat(12).trim()}";`,
        `${quote}\`\`\``
      ].join("\n")
      : [
        `${quote}~~~ts`,
        `${quote}type Row = { value: number };`,
        `${quote}const first: Row = { value: 1 };`,
        `${quote}const second: Row = { value: 2 }; // open fence`
      ].join("\n");

    for (const [colors, scheme] of themes) {
      const theme = createTheme(colors, scheme);
      const streamed = new RichMarkdown("", 1, theme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new Markdown(
          withoutBoundaryBlankLines(prefix),
          1,
          0,
          theme.markdown
        );
        for (const width of [40, 60, 80, 100]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
      const internal = streamed as unknown as {
        renderedSegments: Array<{
          component: {
            constructor: { name: string };
            fence?: { quoteDepth: number };
            widthState?: { body: { characters: number } };
          };
        }>;
      };
      expect(internal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingQuotedFencedCodeMarkdown");
      expect(internal.renderedSegments[0]?.component.fence?.quoteDepth).toBe(depth);
      expect(internal.renderedSegments[0]?.component.widthState?.body.characters)
        .toBeLessThanOrEqual(2_000_000);
    }
  }

  test("keeps closed depth-three TypeScript fences byte-identical", () => {
    expectDeepQuotedFenceByteIdentical(3, true);
  });

  test("keeps open depth-three TypeScript fences byte-identical", () => {
    expectDeepQuotedFenceByteIdentical(3, false);
  });

  test("keeps no-color closed depth-four TypeScript fences byte-identical", () => {
    expectDeepQuotedFenceByteIdentical(4, true, [[false, "dark"]]);
  });

  test("keeps dark closed depth-four TypeScript fences byte-identical", () => {
    expectDeepQuotedFenceByteIdentical(4, true, [[true, "dark"]]);
  });

  test("keeps light closed depth-four TypeScript fences byte-identical", () => {
    expectDeepQuotedFenceByteIdentical(4, true, [[true, "light"]]);
  });

  test("keeps open depth-four TypeScript fences byte-identical", () => {
    expectDeepQuotedFenceByteIdentical(4, false);
  });

  test("keeps unsafe quoted fences on the original Markdown path", () => {
    for (const source of [
      "> ```typescript\n> const value = `first\n> second`;\n> const tail = 1;",
      "> ```typescript\n> /* open\n> still comment */\n> const tail = 1;",
      "> ```typescript\n> const value = {\n>   id: 1\n> };",
      "> ```typescript\n> function empty(): number {\n> }",
      "> ```typescript\n> function multiline(\n>   input: number\n> ): number {\n>   return input;\n> }",
      "> ```typescript\n> function alternative(input: number): number {\n>   if (input > 0) {\n>     return input;\n>   } else {\n>     return 0;\n>   }\n> }",
      "> > ```typescript\n> > function value(): number {\n> >   return 1;\n> > }",
      "> ```tsx\n> const view = <Panel />;\n> const tail = 1;",
      "> > > > > ```typescript\n> > > > > const first = 1;\n> > > > > const second = 2;",
      "> > ```typescript\n> > const first = 1;\n> const second = 2;",
      ">```typescript\n> const first = 1;\n> const second = 2;",
      "> ```python\n> text = \"\"\"first\n> second\"\"\"",
      "> ```python\n> text = fr\"value {answer}\"\n> tail = 1",
      "> ```python\n> value = 1 + \\\n>   2",
      "> ```python\n> values = (\n>   1,\n> )",
      "> ```python\n> \tvalue = 1\n> tail = 2",
      "> > ```python\n> > first: int = 1\n> > second: int = 2",
      "> ```python\n> text = f\"{value:{width}}\"\n> tail = 1",
      "> ```python\n> text = f\"{value + 1}\"\n> tail = 1",
      "> ```python\n> text = f\"{mapping[key]}\"\n> tail = 1",
      "> ```python\n> text = f\"{value=}\"\n> tail = 1",
      "> > ```python\n> > text = f\"value {answer}\"\n> > tail = 1",
      "> ```javascript\n> const value = `first\n> second`;\n> const tail = 1;",
      "> ```javascript\n> /* open\n> still comment */\n> const tail = 1;",
      "> ```javascript\n> const value = {\n>   id: 1\n> };",
      "> ```javascript\n> function value(input) {\n>   if (input) {\n>     return input;\n>   } else {\n>     return 0;\n>   }\n> }",
      "> ```javascript\n> const value = 1 + \\\n>   2;",
      "> ```javascript\n> \tconst value = 1;\n> const tail = 2;",
      "> ```javascript\n> const view = <Panel />;\n> const tail = 1;",
      "> > ```javascript\n> > const first = 1;\n> > const second = 2;",
      ">```javascript\n> const first = 1;\n> const second = 2;",
      "> ```jsx\n> const view = <Panel />;",
      `> \`\`\`typescript\n> const first = "${"x".repeat(100_000)}";\n> const second = 2;`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      component.render(80);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("avoids incremental setup for a restored large quoted TypeScript fence", () => {
    const lines = Array.from(
      { length: 90 },
      (_, index) => `> const value_${index}: number = ${index}; // generated`
    );
    const source = [`> \`\`\`typescript`, ...lines].join("\n");
    const restored = new RichMarkdown(source, 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(
      [`> \`\`\`typescript`, ...lines.slice(0, 2)].join("\n"),
      1,
      createTheme(true)
    );
    streamed.render(80);
    streamed.appendText(`\n${lines.slice(2).join("\n")}`);
    const full = streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingQuotedFencedCodeMarkdown");
    expect(streamed.renderWindow(80, 20, 30)).toEqual({
      lines: full.slice(20, 50),
      totalLines: full.length
    });

    streamed.setText(source.replaceAll("generated", "replacement"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("avoids incremental setup for restored depth-two TypeScript fences", () => {
    const lines = Array.from(
      { length: 90 },
      (_, index) => `> > const value_${index}: number = ${index}; // generated`
    );
    const source = [`> > \`\`\`typescript`, ...lines].join("\n");
    const restored = new RichMarkdown(source, 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(
      [`> > \`\`\`typescript`, ...lines.slice(0, 2)].join("\n"),
      1,
      createTheme(true)
    );
    streamed.render(80);
    streamed.appendText(`\n${lines.slice(2).join("\n")}`);
    const full = streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{
        component: { constructor: { name: string }; fence?: { quoteDepth: number } };
      }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingQuotedFencedCodeMarkdown");
    expect(streamedInternal.renderedSegments[0]?.component.fence?.quoteDepth).toBe(2);
    expect(streamed.renderWindow(80, 20, 30)).toEqual({
      lines: full.slice(20, 50),
      totalLines: full.length
    });

    streamed.setText(source.replaceAll("generated", "replacement"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("avoids incremental setup for restored depth-three and depth-four fences", () => {
    for (const depth of [3, 4] as const) {
      const quote = "> ".repeat(depth);
      const lines = Array.from(
        { length: 90 },
        (_, index) => `${quote}const value_${index}: number = ${index}; // generated`
      );
      const source = [`${quote}\`\`\`typescript`, ...lines].join("\n");
      const restored = new RichMarkdown(source, 1, createTheme(true));
      restored.render(80);
      const restoredInternal = restored as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

      const streamed = new RichMarkdown(
        [`${quote}\`\`\`typescript`, ...lines.slice(0, 2)].join("\n"),
        1,
        createTheme(true)
      );
      streamed.render(80);
      streamed.appendText(`\n${lines.slice(2).join("\n")}`);
      const full = streamed.render(80);
      const streamedInternal = streamed as unknown as {
        renderedSegments: Array<{
          component: { constructor: { name: string }; fence?: { quoteDepth: number } };
        }>;
      };
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingQuotedFencedCodeMarkdown");
      expect(streamedInternal.renderedSegments[0]?.component.fence?.quoteDepth).toBe(depth);
      expect(streamed.renderWindow(80, 20, 30)).toEqual({
        lines: full.slice(20, 50),
        totalLines: full.length
      });

      streamed.setText(source.replaceAll("generated", "replacement"));
      streamed.render(80);
      const replacedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("avoids incremental setup for a restored large quoted Python fence", () => {
    const lines = Array.from(
      { length: 90 },
      (_, index) => `> value_${index}: int = ${index}  # generated output`
    );
    const source = [`> \`\`\`python`, ...lines].join("\n");
    const restored = new RichMarkdown(source, 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(
      [`> \`\`\`python`, ...lines.slice(0, 2)].join("\n"),
      1,
      createTheme(true)
    );
    streamed.render(80);
    streamed.appendText(`\n${lines.slice(2).join("\n")}`);
    const full = streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{
        component: {
          constructor: { name: string };
          fence?: { language: string; quoteDepth: number };
        };
      }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingQuotedFencedCodeMarkdown");
    expect(streamedInternal.renderedSegments[0]?.component.fence?.quoteDepth).toBe(1);
    expect(streamed.renderWindow(80, 20, 30)).toEqual({
      lines: full.slice(20, 50),
      totalLines: full.length
    });

    streamed.setText(source.replaceAll("generated", "replacement"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("avoids incremental setup for restored large JavaScript fences", () => {
    for (const quoted of [false, true]) {
      const sourcePrefix = quoted ? "> " : "";
      const lines = Array.from(
        { length: 90 },
        (_, index) => `${sourcePrefix}const value_${index} = ${index}; // generated`
      );
      const source = [`${sourcePrefix}\`\`\`javascript`, ...lines].join("\n");
      const restored = new RichMarkdown(source, 1, createTheme(true));
      restored.render(80);
      const restoredInternal = restored as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

      const streamed = new RichMarkdown(
        [`${sourcePrefix}\`\`\`javascript`, ...lines.slice(0, 2)].join("\n"),
        1,
        createTheme(true)
      );
      streamed.render(80);
      streamed.appendText(`\n${lines.slice(2).join("\n")}`);
      const full = streamed.render(80);
      const streamedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: { constructor: { name: string } } }>;
      };
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
        .toBe(quoted
          ? "StreamingQuotedFencedCodeMarkdown"
          : "StreamingFencedCodeMarkdown");
      expect(streamed.renderWindow(80, 20, 30)).toEqual({
        lines: full.slice(20, 50),
        totalLines: full.length
      });

      streamed.setText(source.replaceAll("generated", "replacement"));
      streamed.render(80);
      const replacedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("keeps JavaScript function owners through growth and skips restored setup", () => {
    for (const quoted of [false, true]) {
      const sourcePrefix = quoted ? "> " : "";
      const lines = Array.from({ length: 90 }, (_, index) => [
        `${sourcePrefix}function generated_${index}(input) {`,
        `${sourcePrefix}  return input + ${index};`,
        `${sourcePrefix}}`
      ]).flat();
      const opening = `${sourcePrefix}\`\`\`javascript`;
      const source = [opening, ...lines].join("\n");
      const restored = new RichMarkdown(source, 1, createTheme(true));
      restored.render(80);
      const restoredInternal = restored as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

      const theme = createTheme(true);
      const streamed = new RichMarkdown(
        [opening, ...lines.slice(0, 3)].join("\n"),
        1,
        theme
      );
      streamed.render(80);
      streamed.appendText(`\n${lines.slice(3).join("\n")}`);
      const full = streamed.render(80);
      const expectedName = quoted
        ? "StreamingQuotedFencedCodeMarkdown"
        : "StreamingFencedCodeMarkdown";
      const streamedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: { constructor: { name: string } } }>;
      };
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name).toBe(expectedName);
      expect(streamed.renderWindow(80, 20, 30)).toEqual({
        lines: full.slice(20, 50),
        totalLines: full.length
      });

      let expectedSource = `${source}\n`;
      streamed.appendText("\n");
      const partial = `${sourcePrefix}function partial_${quoted ? "quoted" : "root"}`;
      for (const character of partial) {
        expectedSource += character;
        streamed.appendText(character);
        expect(streamed.render(80)).toEqual(
          new Markdown(
            withoutBoundaryBlankLines(expectedSource),
            1,
            0,
            theme.markdown
          ).render(80)
        );
        expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
          .toBe(expectedName);
      }

      streamed.setText(source.replaceAll("generated", "replacement"));
      streamed.render(80);
      const replacedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("keeps nested-if JavaScript function owners through growth and skips restored setup", () => {
    for (const quoted of [false, true]) {
      const sourcePrefix = quoted ? "> " : "";
      const lines = Array.from({ length: 70 }, (_, index) => [
        `${sourcePrefix}function generated_${index}(input) {`,
        `${sourcePrefix}  if (input > ${index}) {`,
        `${sourcePrefix}    return input + ${index};`,
        `${sourcePrefix}  }`,
        `${sourcePrefix}}`
      ]).flat();
      const opening = `${sourcePrefix}\`\`\`javascript`;
      const source = [opening, ...lines].join("\n");
      const restored = new RichMarkdown(source, 1, createTheme(true));
      restored.render(80);
      const restoredInternal = restored as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

      const streamed = new RichMarkdown(
        [opening, ...lines.slice(0, 5)].join("\n"),
        1,
        createTheme(true)
      );
      streamed.render(80);
      streamed.appendText(`\n${lines.slice(5).join("\n")}`);
      const full = streamed.render(80);
      const expectedName = quoted
        ? "StreamingQuotedFencedCodeMarkdown"
        : "StreamingFencedCodeMarkdown";
      const streamedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: { constructor: { name: string } } }>;
      };
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name).toBe(expectedName);
      expect(streamed.renderWindow(80, 20, 30)).toEqual({
        lines: full.slice(20, 50),
        totalLines: full.length
      });

      streamed.setText(source.replaceAll("generated", "replacement"));
      streamed.render(80);
      const replacedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("avoids incremental setup for restored large Python f-string fences", () => {
    for (const quoted of [false, true]) {
      const sourcePrefix = quoted ? "> " : "";
      const lines = Array.from(
        { length: 90 },
        (_, index) => `${sourcePrefix}value_${index} = f"generated {${index}}"  # output`
      );
      const source = [`${sourcePrefix}\`\`\`python`, ...lines].join("\n");
      const restored = new RichMarkdown(source, 1, createTheme(true));
      restored.render(80);
      const restoredInternal = restored as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

      const streamed = new RichMarkdown(
        [`${sourcePrefix}\`\`\`python`, ...lines.slice(0, 2)].join("\n"),
        1,
        createTheme(true)
      );
      streamed.render(80);
      streamed.appendText(`\n${lines.slice(2).join("\n")}`);
      const full = streamed.render(80);
      const streamedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: { constructor: { name: string } } }>;
      };
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
        .toBe(quoted
          ? "StreamingQuotedFencedCodeMarkdown"
          : "StreamingFencedCodeMarkdown");
      expect(streamed.renderWindow(80, 20, 30)).toEqual({
        lines: full.slice(20, 50),
        totalLines: full.length
      });

      streamed.setText(source.replaceAll("generated", "replacement"));
      streamed.render(80);
      const replacedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("keeps strict root tables byte-identical for every streaming prefix", () => {
    const source = [
      "| Index | Value | Result |",
      "| ---: | :--- | :--- |",
      "| 1 | **bold value** | generated output |",
      "| 10 | `inline code` | 中文 ✅ |",
      "| 100 | *italic value* | ~~deleted result~~ |",
      `| 101 | [official link](https://example.com) | ${"wrapped words ".repeat(5).trim()} |`
    ].join("\n");

    for (const [colors, scheme] of [
      [false, "dark"],
      [true, "dark"],
      [true, "light"]
    ] as const) {
      const theme = createTheme(colors, scheme);
      const streamed = new RichMarkdown("", 1, theme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new Markdown(
          withoutBoundaryBlankLines(prefix),
          1,
          0,
          theme.markdown
        );
        for (const width of [40, 60, 80, 100]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
      const internal = streamed as unknown as {
        renderedSegments: Array<{
          component: {
            constructor: { name: string };
            widthState?: { characters: number; presentedRows: string[][] };
          };
        }>;
      };
      expect(internal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingStableTableMarkdown");
      expect(internal.renderedSegments[0]?.component.widthState?.presentedRows.length).toBe(4);
      expect(internal.renderedSegments[0]?.component.widthState?.characters)
        .toBeLessThanOrEqual(2_000_000);
    }
  });

  test("keeps unsupported table shapes on the original Markdown path", () => {
    const tooManyColumns = `| ${Array.from({ length: 9 }, (_, index) => `h${index}`).join(" | ")} |\n| ${
      Array.from({ length: 9 }, () => "---").join(" | ")
    } |\n| ${Array.from({ length: 9 }, () => "value").join(" | ")} |`;
    for (const source of [
      "Index | Value\n--- | ---\n1 | value",
      "| Index | Value |\n| --- | --- |\n| 1 | value",
      "| Index | Value |\n| --- | --- |\n| 1 | |",
      "| Index | Value |\n| --- | --- |\n| 1 | value | extra |",
      "| Index | Value |\n| --- | --- |\n| 1 | escaped \\| pipe |",
      "| Index | Value |\n| --- | --- |\n| 1 | `code | pipe` |",
      "| Index | Value |\n| --- | --- |\n| 1 | # heading |",
      "| **semantic header** | Value |\n| --- | --- |\n| 1 | value |",
      "| Index | Value |\n| --- | --- |\n\n| 1 | value |",
      tooManyColumns,
      `| Index | Value |\n| --- | --- |\n| 1 | ${"x".repeat(100_000)} |`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      component.render(80);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
    }
  });

  test("avoids incremental setup for a restored large table", () => {
    const opening = "| Index | Value |\n| ---: | :--- |\n";
    const rows = Array.from(
      { length: 65 },
      (_, index) => `| ${index} | **value ${index}** |`
    );
    const restored = new RichMarkdown(`${opening}${rows.join("\n")}`, 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(`${opening}${rows[0]}`, 1, createTheme(true));
    streamed.render(80);
    streamed.appendText(`\n${rows.slice(1).join("\n")}`);
    streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: { constructor: { name: string } } }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableTableMarkdown");

    streamed.setText(`| Replacement | Value |\n| ---: | :--- |\n${rows.join("\n")}`);
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("keeps flat plain blockquotes byte-identical for every streaming prefix", () => {
    const source = [
      "> first quoted line grows token by token",
      `> ${"wrapped words ".repeat(12).trim()}`,
      "> 中文宽度 and emoji ✅ remain aligned"
    ].join("\n");

    for (const [colors, scheme] of [
      [false, "dark"],
      [true, "dark"],
      [true, "light"]
    ] as const) {
      const theme = createTheme(colors, scheme);
      const streamed = new RichMarkdown("", 1, theme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new Markdown(
          withoutBoundaryBlankLines(prefix),
          1,
          0,
          theme.markdown
        );
        for (const width of [40, 60, 80, 100]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
      const internal = streamed as unknown as {
        renderedSegments: Array<{
          component: {
            constructor: { name: string };
            widthState?: { characters: number };
          };
        }>;
      };
      expect(internal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingFlatBlockquoteMarkdown");
      expect(internal.renderedSegments[0]?.component.widthState?.characters)
        .toBeLessThanOrEqual(2_000_000);
    }
  });

  test("keeps line-local semantic blockquotes byte-identical for every streaming prefix", () => {
    const source = [
      "> **bold quote** ordinary tail grows token by token",
      "> ordinary plain line remains inside the semantic quote",
      `> \`inline ** [literal] > @ code\` ${"wrapped words ".repeat(10).trim()}`,
      "> **中文宽度 ✅** with ~~deleted text~~ remains aligned",
      "> *italic quote* and _second emphasis_ stay line-local",
      "> __underscore strong__ keeps the original Markdown styling",
      "> [official link](https://example.com/path) remains clickable"
    ].join("\n");

    for (const [colors, scheme] of [
      [false, "dark"],
      [true, "dark"],
      [true, "light"]
    ] as const) {
      const theme = createTheme(colors, scheme);
      const streamed = new RichMarkdown("", 1, theme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new Markdown(
          withoutBoundaryBlankLines(prefix),
          1,
          0,
          theme.markdown
        );
        for (const width of [40, 60, 80, 100]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
      const internal = streamed as unknown as {
        renderedSegments: Array<{
          component: {
            constructor: { name: string };
            widthState?: { characters: number };
          };
        }>;
      };
      expect(internal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingLineLocalBlockquoteMarkdown");
      expect(internal.renderedSegments[0]?.component.widthState?.characters)
        .toBeLessThanOrEqual(2_000_000);
    }
  });

  test("keeps quoted flat lists byte-identical for every streaming prefix", () => {
    const source = [
      "> - **bold item** ordinary tail grows token by token",
      `> + \`inline code\` ${"wrapped words ".repeat(10).trim()}`,
      "> * [ ] pending 中文 task ✅",
      "> - [x] completed task"
    ].join("\n");

    for (const [colors, scheme] of [
      [false, "dark"],
      [true, "dark"],
      [true, "light"]
    ] as const) {
      const theme = createTheme(colors, scheme);
      const streamed = new RichMarkdown("", 1, theme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new Markdown(
          withoutBoundaryBlankLines(prefix),
          1,
          0,
          theme.markdown
        );
        for (const width of [40, 60, 80, 100]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
      const internal = streamed as unknown as {
        renderedSegments: Array<{
          component: {
            constructor: { name: string };
            widthState?: { characters: number };
          };
        }>;
      };
      expect(internal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingStableListMarkdown");
      expect(internal.renderedSegments[0]?.component.widthState?.characters)
        .toBeLessThanOrEqual(2_000_000);
    }
  });

  test("normalizes quoted ordered items exactly like the whole Markdown renderer", () => {
    const sources = [
      [
        "> 1. **first item** ordinary tail",
        "> 1. `second item` with more words",
        "> 1. [ ] pending 中文 task ✅",
        "> 1. [x] completed task"
      ].join("\n"),
      [
        "> 7) starts from seven",
        "> 8) **continues at eight**",
        "> 9) final item wraps with additional generated words"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{ component: { constructor: { name: string } } }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingStableListMarkdown");
      }
    }
  });

  test("keeps loose quoted lists byte-identical for every streaming prefix", () => {
    const sources = [
      [
        "> - **bold item** ordinary tail grows token by token",
        ">",
        `> * \`inline code\` ${"wrapped words ".repeat(10).trim()}`,
        ">",
        "> + [ ] pending 中文 task ✅",
        ">",
        "> - [x] completed task",
        ">"
      ].join("\n"),
      [
        "> + plain first item with generated output",
        ">",
        "> - *italic second item* with more words",
        ">",
        "> * [official link](https://example.com/path) final item"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              quotedBlankSeparators?: Map<number, string>;
              separatorKind?: string;
              widthState?: { characters: number };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingStableListMarkdown");
        expect(internal.renderedSegments[0]?.component.separatorKind).toBe("quoted-blank");
        expect(internal.renderedSegments[0]?.component.quotedBlankSeparators?.size).toBe(4);
        expect(internal.renderedSegments[0]?.component.widthState?.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  test("avoids incremental setup for a restored large loose quoted list", () => {
    const items = Array.from(
      { length: 65 },
      (_, index) => `> ${["-", "*", "+"][index % 3]} **item ${index}** generated output`
    );
    const source = items.join("\n>\n");
    const restored = new RichMarkdown(source, 1, createTheme(true));
    restored.render(80);
    const restoredInternal = restored as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

    const streamed = new RichMarkdown(items.slice(0, 2).join("\n>\n"), 1, createTheme(true));
    streamed.render(80);
    streamed.appendText(`\n>\n${items.slice(2).join("\n>\n")}`);
    streamed.render(80);
    const streamedInternal = streamed as unknown as {
      renderedSegments: Array<{
        component: { constructor: { name: string }; separatorKind?: string };
      }>;
    };
    expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");
    expect(streamedInternal.renderedSegments[0]?.component.separatorKind).toBe("quoted-blank");

    streamed.setText(source.replaceAll("generated", "replacement"));
    streamed.render(80);
    const replacedInternal = streamed as unknown as {
      renderedSegments: Array<{ component: unknown }>;
    };
    expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
  });

  test("falls back when the quoted blank separator probe wraps", () => {
    const source = "> - first\n>\n> * second";
    const theme = createTheme(true);
    const component = new RichMarkdown(source, 1, theme);
    expect(component.render(4)).toEqual(new Markdown(source, 1, 0, theme.markdown).render(4));

    const internal = component as unknown as {
      renderedSegments: Array<{
        component: {
          constructor: { name: string };
          quotedBlankSeparators?: Map<number, string>;
          rejectedWidths?: Set<number>;
        };
      }>;
    };
    expect(internal.renderedSegments[0]?.component.constructor.name)
      .toBe("StreamingStableListMarkdown");
    expect(internal.renderedSegments[0]?.component.rejectedWidths?.has(4)).toBeTrue();
    expect(internal.renderedSegments[0]?.component.quotedBlankSeparators?.has(4)).toBeFalse();

    expect(component.render(40)).toEqual(new Markdown(source, 1, 0, theme.markdown).render(40));
    expect(internal.renderedSegments[0]?.component.quotedBlankSeparators?.has(40)).toBeTrue();
  });

  function expectNestedQuotedListDepthByteIdentical(depth: 2 | 3): void {
    const quote = "> ".repeat(depth);
    const sources = [
      [
        `${quote}- **bold item** ordinary tail grows token by token`,
        `${quote}+ \`inline code\` ${"wrapped words ".repeat(10).trim()}`,
        `${quote}* [ ] pending 中文 task ✅`,
        `${quote}- [x] completed task`
      ].join("\n"),
      [
        `${quote}7) starts from seven`,
        `${quote}7) **source marker is normalized to eight**`,
        `${quote}7) final ordered item wraps with additional generated words`
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              widthState?: { characters: number };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingStableListMarkdown");
        expect(internal.renderedSegments[0]?.component.widthState?.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  }

  test("keeps one-level nested quoted lists byte-identical for every streaming prefix", () => {
    expectNestedQuotedListDepthByteIdentical(2);
  });

  test("keeps depth-three quoted lists byte-identical for every streaming prefix", () => {
    expectNestedQuotedListDepthByteIdentical(3);
  });

  test("avoids incremental setup for restored large nested quoted lists", () => {
    for (const depth of [2, 3] as const) {
      const label = `depth-${depth}`;
      const lines = Array.from(
        { length: 65 },
        (_, index) => `${"> ".repeat(depth)}- **${label} item ${index}** generated output`
      );
      const restored = new RichMarkdown(lines.join("\n"), 1, createTheme(true));
      restored.render(80);
      const restoredInternal = restored as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

      const streamed = new RichMarkdown(lines[0]!, 1, createTheme(true));
      streamed.render(80);
      streamed.appendText(`\n${lines.slice(1).join("\n")}`);
      streamed.render(80);
      const streamedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: { constructor: { name: string } } }>;
      };
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingStableListMarkdown");

      streamed.setText(lines.map((line) => line.replace(label, "replacement")).join("\n"));
      streamed.render(80);
      const replacedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("keeps one-level nested plain and semantic blockquotes byte-identical", () => {
    const sources = [
      [
        "> > first nested line grows token by token",
        `> > ${"wrapped words ".repeat(12).trim()}`,
        "> > 中文宽度 and emoji ✅ remain aligned"
      ].join("\n"),
      [
        "> > **bold quote** ordinary tail grows token by token",
        "> > ordinary plain line remains in the nested paragraph",
        `> > \`inline ** [literal] > @ code\` ${"wrapped words ".repeat(10).trim()}`,
        "> > *italic quote* and ~~deleted text~~ remain line-local",
        "> > [official link](https://example.com/path) stays nested"
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              widthState?: { characters: number };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingLineLocalBlockquoteMarkdown");
        expect(internal.renderedSegments[0]?.component.widthState?.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  });

  function expectNestedBlockquoteDepthByteIdentical(depth: 3 | 4): void {
    const quote = "> ".repeat(depth);
    const sources = [
      [
        `${quote}first depth-${depth} line grows token by token`,
        `${quote}${"wrapped words ".repeat(12).trim()}`,
        `${quote}中文宽度 and emoji ✅ remain aligned`
      ].join("\n"),
      [
        `${quote}**bold quote** ordinary tail grows token by token`,
        `${quote}ordinary plain line remains in the paragraph`,
        `${quote}\`inline ** [literal] > @ code\` ${"wrapped words ".repeat(10).trim()}`,
        `${quote}*italic quote* and ~~deleted text~~ remain line-local`,
        `${quote}[official link](https://example.com/path) stays depth-${depth}`
      ].join("\n")
    ];

    for (const source of sources) {
      for (const [colors, scheme] of [
        [false, "dark"],
        [true, "dark"],
        [true, "light"]
      ] as const) {
        const theme = createTheme(colors, scheme);
        const streamed = new RichMarkdown("", 1, theme);
        let prefix = "";
        for (const character of source) {
          prefix += character;
          streamed.appendText(character);
          const expected = new Markdown(
            withoutBoundaryBlankLines(prefix),
            1,
            0,
            theme.markdown
          );
          for (const width of [40, 60, 80, 100]) {
            expect(streamed.render(width)).toEqual(expected.render(width));
          }
        }
        const internal = streamed as unknown as {
          renderedSegments: Array<{
            component: {
              constructor: { name: string };
              quoteDepth?: number;
              widthState?: { characters: number };
            };
          }>;
        };
        expect(internal.renderedSegments[0]?.component.constructor.name)
          .toBe("StreamingLineLocalBlockquoteMarkdown");
        expect(internal.renderedSegments[0]?.component.quoteDepth).toBe(depth);
        expect(internal.renderedSegments[0]?.component.widthState?.characters)
          .toBeLessThanOrEqual(2_000_000);
      }
    }
  }

  test("keeps depth-three line-local blockquotes byte-identical", () => {
    expectNestedBlockquoteDepthByteIdentical(3);
  });

  test("keeps depth-four line-local blockquotes byte-identical", () => {
    expectNestedBlockquoteDepthByteIdentical(4);
  }, 10_000);

  test("avoids incremental setup for a restored large nested blockquote", () => {
    for (const depth of [3, 4] as const) {
      const label = `depth-${depth}`;
      const lines = Array.from(
        { length: 65 },
        (_, index) => `${"> ".repeat(depth)}**${label} ${index}** generated output`
      );
      const restored = new RichMarkdown(lines.join("\n"), 1, createTheme(true));
      restored.render(80);
      const restoredInternal = restored as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

      const streamed = new RichMarkdown(lines[0]!, 1, createTheme(true));
      streamed.render(80);
      streamed.appendText(`\n${lines.slice(1).join("\n")}`);
      streamed.render(80);
      const streamedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: { constructor: { name: string } } }>;
      };
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingLineLocalBlockquoteMarkdown");

      const replacement = lines.map((line) => line.replace(label, "replacement"));
      streamed.setText(replacement.join("\n"));
      streamed.render(80);
      const replacedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("keeps quoted list continuation chunks byte-identical for every prefix", () => {
    const source = [
      "> - **first item** ordinary tail grows token by token",
      `>   continuation with *italic* ${"wrapped words ".repeat(10).trim()}`,
      ">   second continuation keeps `inline code` local",
      "> + [ ] pending task without continuation",
      "> * final 中文 item ✅",
      ">   final continuation with ~~deleted text~~"
    ].join("\n");

    for (const [colors, scheme] of [
      [false, "dark"],
      [true, "dark"],
      [true, "light"]
    ] as const) {
      const theme = createTheme(colors, scheme);
      const streamed = new RichMarkdown("", 1, theme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new Markdown(
          withoutBoundaryBlankLines(prefix),
          1,
          0,
          theme.markdown
        );
        for (const width of [40, 60, 80, 100]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
      const internal = streamed as unknown as {
        renderedSegments: Array<{
          component: {
            constructor: { name: string };
            widthState?: { characters: number };
          };
        }>;
      };
      expect(internal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingStableListMarkdown");
      expect(internal.renderedSegments[0]?.component.widthState?.characters)
        .toBeLessThanOrEqual(2_000_000);
    }
  });

  test("keeps cross-line semantic quote chunks byte-identical for every streaming prefix", () => {
    const source = [
      "> **strong starts across",
      "> the next line closes** with a plain tail",
      "> ordinary plain line between semantic chunks",
      "> `code starts with ** literal markers",
      "> and closes here` with more words",
      "> ~~strike starts 中文",
      "> and closes ✅~~ final tail",
      "> *italic starts across",
      "> and closes here* end"
    ].join("\n");

    for (const [colors, scheme] of [
      [false, "dark"],
      [true, "dark"],
      [true, "light"]
    ] as const) {
      const theme = createTheme(colors, scheme);
      const streamed = new RichMarkdown("", 1, theme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new Markdown(
          withoutBoundaryBlankLines(prefix),
          1,
          0,
          theme.markdown
        );
        for (const width of [40, 60, 80, 100]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
      const internal = streamed as unknown as {
        renderedSegments: Array<{
          component: {
            constructor: { name: string };
            widthState?: { characters: number };
          };
        }>;
      };
      expect(internal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingCrossLineBlockquoteMarkdown");
      expect(internal.renderedSegments[0]?.component.widthState?.characters)
        .toBeLessThanOrEqual(2_000_000);
    }
  });

  function expectNestedCrossLineQuoteByteIdentical(depth: 2 | 3): void {
    const quote = "> ".repeat(depth);
    const source = [
      "**strong starts across",
      "the next line closes** with a plain tail",
      "ordinary plain line between semantic chunks",
      "`code starts with ** literal markers",
      "and closes here` with more words",
      "~~strike starts 中文",
      "and closes ✅~~ final tail",
      `*italic starts across ${"wrapped words ".repeat(8).trim()}`,
      "and closes here* end",
      "__underscore strong starts across",
      "and closes here__ with a tail",
      "_underscore italic starts across",
      "and closes here_ end"
    ].map((line) => `${quote}${line}`).join("\n");

    for (const [colors, scheme] of [
      [false, "dark"],
      [true, "dark"],
      [true, "light"]
    ] as const) {
      const theme = createTheme(colors, scheme);
      const streamed = new RichMarkdown("", 1, theme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        streamed.appendText(character);
        const expected = new Markdown(
          withoutBoundaryBlankLines(prefix),
          1,
          0,
          theme.markdown
        );
        for (const width of [40, 60, 80, 100]) {
          expect(streamed.render(width)).toEqual(expected.render(width));
        }
      }
      const internal = streamed as unknown as {
        renderedSegments: Array<{
          component: {
            constructor: { name: string };
            quoteDepth?: number;
            widthState?: { characters: number };
          };
        }>;
      };
      expect(internal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingCrossLineBlockquoteMarkdown");
      expect(internal.renderedSegments[0]?.component.quoteDepth).toBe(depth);
      expect(internal.renderedSegments[0]?.component.widthState?.characters)
        .toBeLessThanOrEqual(2_000_000);
    }
  }

  test("keeps one-level nested cross-line semantic quote chunks byte-identical", () => {
    expectNestedCrossLineQuoteByteIdentical(2);
  });

  test("keeps depth-three cross-line semantic quote chunks byte-identical", () => {
    expectNestedCrossLineQuoteByteIdentical(3);
  }, 10_000);

  test("avoids incremental setup for restored large nested cross-line quotes", () => {
    for (const depth of [2, 3] as const) {
      const quote = "> ".repeat(depth);
      const chunks = Array.from(
        { length: 65 },
        (_, index) => [
          `${quote}**chunk ${index} starts across`,
          `${quote}and closes here** with generated output`
        ].join("\n")
      );
      const source = chunks.join("\n");
      const restored = new RichMarkdown(source, 1, createTheme(true));
      restored.render(80);
      const restoredInternal = restored as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(restoredInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);

      const streamed = new RichMarkdown(chunks[0]!, 1, createTheme(true));
      streamed.render(80);
      streamed.appendText(`\n${chunks.slice(1).join("\n")}`);
      streamed.render(80);
      const streamedInternal = streamed as unknown as {
        renderedSegments: Array<{
          component: { constructor: { name: string }; quoteDepth?: number };
        }>;
      };
      expect(streamedInternal.renderedSegments[0]?.component.constructor.name)
        .toBe("StreamingCrossLineBlockquoteMarkdown");
      expect(streamedInternal.renderedSegments[0]?.component.quoteDepth).toBe(depth);

      streamed.setText(source.replaceAll("generated", "replacement"));
      streamed.render(80);
      const replacedInternal = streamed as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(replacedInternal.renderedSegments[0]?.component).toBeInstanceOf(Markdown);
    }
  });

  test("keeps non-flat quoted lists on the original Markdown path", () => {
    for (const source of [
      "> -",
      "> 1.",
      "> 1. first\n> 2) mixed delimiter",
      "> 1. first\n> - unordered transition",
      "> 999999999. first\n> 999999999. overflow",
      "> - first\n>   - nested",
      "> 1. first\n>\n> 2. second",
      "> - first\n\n> - ordinary blank",
      "> - first\n>\n>\n> - double quoted blank",
      "> - first\n>\n>   - nested loose item",
      "> - first\n>\n>   continuation",
      "> - first\n>\n> > - depth transition",
      "> - first\n>\n> # heading transition",
      "> - first\n>\n> - **cross-line starts\n> closes here**",
      "> - first\n>\n> - second\n>\n> -",
      "> - **cross\n>   line**",
      "> - first\n>  wrong indent",
      "> - first\n>    code indent",
      "> 1. first\n>   ordered continuation",
      ">   continuation before item",
      "> > -",
      "> > 1.",
      "> > 1. first\n> > 2) mixed delimiter",
      "> > - first\n> >   continuation",
      "> > - first\n> > paragraph transition",
      "> > > -",
      "> > > 1.",
      "> > > 1. first\n> > > 2) mixed delimiter",
      "> > > - first\n> > >   continuation",
      "> > > - first\n> > > paragraph transition",
      "> > > - **cross\n> > >   line**",
      "> > > - first\n> > - depth transition",
      "> > > > - depth four",
      `> > > - item ${"x".repeat(100_000)}`,
      `> - item ${"x".repeat(100_000)}\n>\n> - second`
    ]) {
      const component = new RichMarkdown(source, 1, createTheme(true));
      expect(component.render(80).length).toBeGreaterThan(0);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
    }
  });

  test("keeps unsafe, loose, and deeper semantic quotes on the original path", () => {
    for (const source of [
      "> **never closes\n> still open",
      "> **nested *inline\n> closes* here**",
      "> **escaped \\\n> delimiter**",
      "> ** spaced open\n> closes here**",
      "> word**intraword open\n> closes here**",
      "> **valid starts\n> closes with space **",
      "> [link starts\n> here](https://example.com)",
      "> > **never closes\n> > still open",
      "> > **nested *inline\n> > closes* here**",
      "> > **escaped \\\n> > delimiter**",
      "> > ** spaced open\n> > closes here**",
      "> > word**intraword open\n> > closes here**",
      "> > **valid starts\n> > closes with space **",
      "> > [link starts\n> > here](https://example.com)",
      "> > **valid starts\n> > closes here**\n> > - list transition",
      "> > **valid starts\n> > closes here**\n> > # heading transition",
      "> > **valid starts\n> > closes here**\n> > ![image](https://example.com/image.png)",
      "> > **valid starts\n> > closes here**\n> > <https://example.com>",
      "> > > **never closes\n> > > still open",
      "> > > **nested *inline\n> > > closes* here**",
      "> > > **escaped \\\n> > > delimiter**",
      "> > > [link starts\n> > > here](https://example.com)",
      "> > > **valid starts\n> > > closes here**\n> > - depth transition",
      "> > > **valid starts\n> > > closes here**\n> > > - list transition",
      "> > > > > depth-five quote",
      "> > > first\n> > depth transition",
      "> > > first\n> > > > deeper transition",
      "> > > first\n> > > - list transition",
      "> > > first\n> > >\n> > > loose paragraph",
      "> > > > first\n> > > depth transition",
      "> > > > first\n> > > > > deeper transition",
      "> > > > first\n> > > > - list transition",
      "> > > > first\n> > > >\n> > > > loose paragraph",
      "> > > > **open across\n> > > > closes here**",
      "> > first\n> >\n> > second",
      "> first\n>\n> second",
      "> ![image](https://example.com/image.png)",
      "> [partial link](https://example.com",
      "> <https://example.com>",
      "> https://example.com",
      `> > **open across\n> > closes here** ${"x".repeat(100_000)}`,
      `> > > **open across\n> > > closes here** ${"x".repeat(100_000)}`
    ]) {
      const theme = createTheme(true);
      const component = new RichMarkdown(source, 1, theme);
      expect(component.render(80).length).toBeGreaterThan(0);
      const internal = component as unknown as {
        renderedSegments: Array<{ component: unknown }>;
      };
      expect(internal.renderedSegments.every((segment) => segment.component instanceof Markdown))
        .toBeTrue();
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
