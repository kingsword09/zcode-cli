import { describe, expect, test } from "bun:test";

import {
  CODE_HIGHLIGHT_CACHE_MAX_CHARACTERS,
  CODE_HIGHLIGHT_CACHE_MAX_ENTRIES,
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

  test("switches to a high-contrast light-terminal palette", () => {
    const highlighter = new CodeHighlighter(true, "dark");
    const dark = highlighter.highlight("const answer = 42;", "typescript").join("\n");
    highlighter.setColorScheme("light");
    const light = highlighter.highlight("const answer = 42;", "typescript").join("\n");

    expect(dark).toContain("\x1b[1;38;5;75mconst");
    expect(light).toContain("\x1b[1;38;5;25mconst");
  });

  test("bounds cached source and ANSI output by entries and total characters", () => {
    const highlighter = new CodeHighlighter(true);
    const internal = highlighter as unknown as {
      cache: Map<string, { characters: number; lines: string[] }>;
      cacheCharacters: number;
    };

    for (let entry = 0; entry < 40; entry += 1) {
      const line = `const value_${entry}: number = ${entry}; // bounded cache line\n`;
      const source = line.repeat(Math.ceil(20_000 / line.length)).slice(0, 20_000);
      highlighter.highlight(source, "typescript");
      expect(internal.cacheCharacters).toBeLessThanOrEqual(CODE_HIGHLIGHT_CACHE_MAX_CHARACTERS);
      expect(internal.cache.size).toBeLessThanOrEqual(CODE_HIGHLIGHT_CACHE_MAX_ENTRIES);
    }
    expect(internal.cacheCharacters).toBeGreaterThan(0);

    highlighter.setColorScheme("light");
    expect(internal.cache.size).toBe(0);
    expect(internal.cacheCharacters).toBe(0);
  });

  test("keeps recently hit entries when the entry limit evicts an older item", () => {
    const highlighter = new CodeHighlighter(true);
    const internal = highlighter as unknown as {
      cache: Map<string, unknown>;
    };
    const source = (entry: number): string => `const cached_${entry} = ${entry};`;
    for (let entry = 0; entry < CODE_HIGHLIGHT_CACHE_MAX_ENTRIES; entry += 1) {
      highlighter.highlight(source(entry), "typescript");
    }

    highlighter.highlight(source(0), "typescript");
    highlighter.highlight(source(CODE_HIGHLIGHT_CACHE_MAX_ENTRIES), "typescript");
    expect(internal.cache.has(`typescript\u0000${source(0)}`)).toBeTrue();
    expect(internal.cache.has(`typescript\u0000${source(1)}`)).toBeFalse();
    expect(internal.cache.size).toBe(CODE_HIGHLIGHT_CACHE_MAX_ENTRIES);
  });
});
