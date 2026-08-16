import { describe, expect, test } from "bun:test";

import {
  MAX_SESSION_TITLE_CHARS,
  SESSION_TITLE_PREFIX,
  emitSessionTerminalTitle,
  sessionTitleFromFirstMessage
} from "../packages/zcode-tui/src/session-title.ts";

describe("session title from first message", () => {
  test("trims and collapses repeated whitespace", () => {
    expect(sessionTitleFromFirstMessage("   fix   the  login   bug  ")).toBe("fix the login bug");
  });

  test("collapses newlines into a single space", () => {
    expect(sessionTitleFromFirstMessage("line one\nline two\n\nline three")).toBe(
      "line one line two line three"
    );
  });

  test("strips terminal control sequences before titling", () => {
    expect(sessionTitleFromFirstMessage("fix \x1b]0;owned\x07 the bug")).toBe("fix the bug");
  });

  test("truncates long messages with an ellipsis", () => {
    const message = "x".repeat(MAX_SESSION_TITLE_CHARS + 20);
    const title = sessionTitleFromFirstMessage(message);
    expect(title).toBe(`${"x".repeat(MAX_SESSION_TITLE_CHARS)}…`);
    expect(Array.from(title!)).toHaveLength(MAX_SESSION_TITLE_CHARS + 1);
  });

  test("truncates by code point without splitting surrogate pairs", () => {
    const emoji = "😀".repeat(MAX_SESSION_TITLE_CHARS + 5);
    expect(sessionTitleFromFirstMessage(emoji)).toBe(`${"😀".repeat(MAX_SESSION_TITLE_CHARS)}…`);
  });

  test("keeps CJK text intact when it fits", () => {
    expect(sessionTitleFromFirstMessage("修复登录页面的空指针")).toBe("修复登录页面的空指针");
  });

  test("returns null for empty or whitespace-only messages", () => {
    expect(sessionTitleFromFirstMessage("")).toBeNull();
    expect(sessionTitleFromFirstMessage("   \n\t ")).toBeNull();
  });
});

describe("terminal title emission", () => {
  interface FakeStream {
    isTTY: boolean;
    output: string;
    write: (chunk: string) => void;
  }

  function fakeStream(isTTY: boolean): FakeStream {
    const stream: FakeStream = {
      isTTY,
      output: "",
      write(chunk: string) {
        stream.output += chunk;
      }
    };
    return stream;
  }

  test("writes the prefixed OSC 0 sequence to a TTY stream", () => {
    const stream = fakeStream(true);
    emitSessionTerminalTitle(stream, "fix the login bug");
    expect(stream.output).toBe(`\x1b]0;${SESSION_TITLE_PREFIX}fix the login bug\x07`);
  });

  test("clears the terminal title when given an empty title", () => {
    const stream = fakeStream(true);
    emitSessionTerminalTitle(stream, "");
    expect(stream.output).toBe("\x1b]0;\x07");
  });

  test("does not write to a non-TTY stream", () => {
    const stream = fakeStream(false);
    emitSessionTerminalTitle(stream, "fix the login bug");
    expect(stream.output).toBe("");
  });

  test("does nothing when no stream is available", () => {
    expect(() => emitSessionTerminalTitle(undefined, "fix the login bug")).not.toThrow();
  });
});
