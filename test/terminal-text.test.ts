import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  sanitizeTerminalText,
  removeLastGrapheme,
  StreamingTerminalTextSanitizer,
  truncateGraphemes,
  truncateTerminalText,
  wrapTerminalText
} from "../packages/zcode-tui/src/terminal-text.ts";

describe("terminal text safety", () => {
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
