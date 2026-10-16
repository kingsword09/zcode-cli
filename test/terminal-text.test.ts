import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER, Input, renderFakeCursor, visibleWidth } from "@earendil-works/pi-tui";
import { terminalOutputText } from "../scripts/terminal-output.ts";

import {
  sanitizeTerminalText,
  removeLastGrapheme,
  stripCaretHighlight,
  StreamingTerminalTextSanitizer,
  truncateGraphemes,
  truncateTerminalText,
  wrapTerminalText
} from "../packages/zcode-tui/src/terminal-text.ts";

describe("terminal text safety", () => {
  test("keeps PTY text after an ST-terminated status query followed by a BEL-terminated title", () => {
    const trace = "\x1b]7501;?\x1b\\\x1b[?1;2c"
      + "\x1b[32m╭─ ◆ ZCODE\x1b[0m\r\n"
      + "\x1b]0;ZCode\x07Ask a task about this workspace\r\n";
    expect(terminalOutputText(trace)).toBe("╭─ ◆ ZCODE\nAsk a task about this workspace\n");
    expect(terminalOutputText("before\x1bPpayload\x1b\\middle\x1b]9;notice\x07after"))
      .toBe("beforemiddleafter");
  });

  test("removes cursor, screen, OSC and string control sequences", () => {
    const unsafe = [
      "before",
      "\x1b[2J",
      "\x1b[1;1H",
      "\x1b]0;owned\x07",
      "\x1bPpayload\x1b\\",
      "after"
    ].join("");

    expect(sanitizeTerminalText(unsafe)).toBe("beforeafter");
  });

  test("strips external SGR by default and preserves it only when explicitly requested", () => {
    expect(sanitizeTerminalText("\x1b[47;8;7m隐藏\x1b[0m\nnext\tcell")).toBe("隐藏\nnext\tcell");
    expect(sanitizeTerminalText("\x1b[31mred\x1b[0m", { preserveSgr: true }))
      .toBe("\x1b[31mred\x1b[0m");
  });

  test("turns carriage-return progress into non-destructive lines", () => {
    expect(sanitizeTerminalText("10%\r20%\r\nDone\b!")).toBe("10%\n20%\nDone!");
  });

  test("matches one-shot sanitizing across every transport chunk boundary", () => {
    const values = [
      "before\x1b[31mred\x1b[0mafter",
      "title\x1b]0;owned\x07safe",
      "left\x1bPpayload\x1b\\right",
      "one\x9b2Jtwo\x9dunsafe\x07three",
      "10%\r20%\r\nDone\tcell",
      "unknown\x1b!escape",
      "unfinished\x1b]discarded"
    ];

    for (const value of values) {
      const expected = sanitizeTerminalText(value);
      for (let split = 0; split <= value.length; split += 1) {
        const sanitizer = new StreamingTerminalTextSanitizer();
        const actual = sanitizer.append(value.slice(0, split))
          + sanitizer.append(value.slice(split))
          + sanitizer.finish();
        expect(actual).toBe(expected);
      }

      const sanitizer = new StreamingTerminalTextSanitizer();
      const actual = Array.from(value, (character) => sanitizer.append(character)).join("")
        + sanitizer.finish();
      expect(actual).toBe(expected);
    }
  });

  test("preserves trusted SGR split across chunks without preserving commands", () => {
    const sanitizer = new StreamingTerminalTextSanitizer({ preserveSgr: true });
    expect(sanitizer.append("\x1b[3")).toBe("");
    expect(sanitizer.append("1mred\x1b[2")).toBe("\x1b[31mred");
    expect(sanitizer.append("Jsafe") + sanitizer.finish()).toBe("safe");
  });

  test("wraps ANSI text and truncates complete terminal graphemes", () => {
    const wrapped = wrapTerminalText("\x1b[31mone two three four\x1b[0m", 8);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.every((line) => visibleWidth(line) <= 8)).toBe(true);
    expect(truncateTerminalText("prefix 👨‍👩‍👧‍👦 suffix", 10)).not.toContain("�");
    expect(truncateTerminalText("prefix 👨‍👩‍👧‍👦 suffix", 10)).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(truncateGraphemes("ab👨‍👩‍👧‍👦cd", 4)).toBe("ab👨‍👩‍👧‍👦…");
    expect(removeLastGrapheme("filter 👨‍👩‍👧‍👦")).toBe("filter ");
  });
});

describe("terminal carets", () => {
  test("preserves placeholder styles, cursor markers and cell widths", () => {
    const input = new Input({
      placeholder: "Find in transcript",
      placeholderStyle: (text) => `\x1b[2m${text}\x1b[22m`
    });
    for (const focused of [false, true]) {
      input.focused = focused;
      const rendered = input.render(40)[0]!;
      const stripped = stripCaretHighlight(rendered);
      expect(stripped).not.toContain("\x1b_pi:fc\x07");
      expect(stripped).not.toContain("\x1b_pi:/fc\x07");
      expect(stripped).toContain(`${focused ? CURSOR_MARKER : ""}\x1b[2mF\x1b[22m`);
      expect(visibleWidth(stripped)).toBe(visibleWidth(rendered));
    }
  });

  test("removes pi-tui fake cursors while retaining styled Unicode and hardware cursor positions", () => {
    for (const grapheme of [" ", "a", "中", "👩‍💻", "é"]) {
      const styled = `\x1b[2m${grapheme}\x1b[22m`;
      expect(stripCaretHighlight(renderFakeCursor(styled))).toBe(styled);
      expect(stripCaretHighlight(`${CURSOR_MARKER}${renderFakeCursor(styled)}`))
        .toBe(`${CURSOR_MARKER}${styled}`);
      // Width truncation can remove the closing APC marker at the right edge.
      expect(stripCaretHighlight(`${CURSOR_MARKER}\x1b_pi:fc\x07${styled}`))
        .toBe(`${CURSOR_MARKER}${styled}`);
    }
  });

  test("handles editor/input reset forms and Unicode with or without keyboard focus", () => {
    for (const reset of [0, 27]) {
      for (const grapheme of [" ", "a", "中", "👩‍💻", "é"]) {
        const caret = `\x1b[7m${grapheme}\x1b[${reset}m`;
        expect(stripCaretHighlight(caret)).toBe(grapheme);
        expect(stripCaretHighlight(`${CURSOR_MARKER}${caret}`)).toBe(`${CURSOR_MARKER}${grapheme}`);
      }
    }
  });
});
