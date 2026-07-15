import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  sanitizeTerminalText,
  removeLastGrapheme,
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
