import { describe, expect, test } from "bun:test";

import {
  CodeHighlighter,
  languageForFilename
} from "../packages/zcode-tui/src/code-highlighter.ts";

describe("TUI code highlighter", () => {
  test("maps common source filenames to supported languages", () => {
    expect(languageForFilename("src/index.ts")).toBe("typescript");
    expect(languageForFilename("component.tsx")).toBe("typescript");
    expect(languageForFilename("scripts/run.sh")).toBe("bash");
    expect(languageForFilename("README.unknown")).toBeUndefined();
  });

  test("keeps plain and oversized input safe while preserving line count", () => {
    const highlighter = new CodeHighlighter(false);
    expect(highlighter.highlight("const value = 1;\nvalue += 1;", "ts")).toEqual([
      "const value = 1;",
      "value += 1;"
    ]);
    expect(highlighter.highlight("\u001b[2Junsafe", "ts")).toEqual(["unsafe"]);
  });

  test("highlights supported languages without changing visible source", () => {
    const lines = new CodeHighlighter(true).highlight("const answer: number = 42;", "typescript");
    expect(lines.join("\n")).toContain("\x1b[");
    const plain = lines.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
    expect(plain).toBe("const answer: number = 42;");
  });
});
