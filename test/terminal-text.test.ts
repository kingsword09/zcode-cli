import { describe, expect, test } from "bun:test";

import { sanitizeTerminalText } from "../packages/zcode-tui/src/terminal-text.ts";

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

  test("preserves printable Unicode, newlines and safe SGR styling", () => {
    expect(sanitizeTerminalText("\x1b[31m红色\x1b[0m\nnext\tcell")).toBe("\x1b[31m红色\x1b[0m\nnext\tcell");
    expect(sanitizeTerminalText("\x1b[31mred", { preserveSgr: false })).toBe("red");
  });

  test("turns carriage-return progress into non-destructive lines", () => {
    expect(sanitizeTerminalText("10%\r20%\r\nDone\b!")).toBe("10%\n20%\nDone!");
  });
});
