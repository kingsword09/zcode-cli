import { describe, expect, test } from "bun:test";

import {
  ACTIVE_TYPESCRIPT_HIGHLIGHT_MAX_CHARACTERS,
  CODE_HIGHLIGHT_CACHE_MAX_CHARACTERS,
  CODE_HIGHLIGHT_CACHE_MAX_ENTRIES,
  CodeHighlighter,
  isIncrementalTypescriptSource,
  isLineLocalFunctionScript,
  isLineLocalScript,
  isSingleOpenScriptFunction,
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

  test("classifies only context-free completed script lines as reusable", () => {
    expect(isLineLocalScript([
      "const answer = 42;",
      "const matcher = /hello\\s+world/iu;",
      "const optional = payload?.value ?? \"fallback\";",
      ""
    ].join("\n"))).toBeTrue();

    for (const source of [
      "const template = `first\nsecond`;\n",
      "/* open\nstill comment */\n",
      "const value = {\n  id: 1\n};\n",
      "const value = 1 + \\\n  2;\n",
      "const value = [1, 2};\n"
    ]) {
      expect(isLineLocalScript(source)).toBeFalse();
    }
  });

  test("classifies only bounded adjacent function physical lines as reusable", () => {
    const source = [
      "function first(input) {",
      "  const doubled = input * 2;",
      "  return doubled;",
      "}",
      "export async function second(input: number): Promise<number> {",
      "  await Promise.resolve(input);",
      "  return input + 1;",
      "}"
    ].join("\n");
    expect(isLineLocalFunctionScript(source)).toBeTrue();
    expect(isLineLocalFunctionScript(`${source}\nfunction partial`, true)).toBeTrue();
    expect(isLineLocalFunctionScript(`${source}\nfunction partial`)).toBeFalse();
    expect(isLineLocalFunctionScript("function open(input) {\n  return input;"))
      .toBeTrue();
    expect(isIncrementalTypescriptSource("function open(input: number): number {")).toBeTrue();
    expect(isIncrementalTypescriptSource(
      "function open(input: number): number {\n  return input"
    )).toBeTrue();

    const nestedIf = [
      "function nested(input) {",
      "  const matcher = /value+/g;",
      "  if (matcher.test(input)) {",
      "    return \"中文 ✅\";",
      "  }",
      "  return input;",
      "}"
    ].join("\n");
    expect(isLineLocalFunctionScript(nestedIf)).toBeTrue();
    expect(isLineLocalFunctionScript("function nested(input) {\n  if (input) {"))
      .toBeTrue();
    expect(isLineLocalFunctionScript(`${nestedIf}\nfunction partial`, true)).toBeTrue();

    for (const unsafe of [
      "function empty() {\n}",
      "function blank() {\n\n  return 1;\n}",
      "function multiline(\n  input\n) {\n  return input;\n}",
      "function emptyNested(input) {\n  if (input) {\n  }\n  return input;\n}",
      "function secondNested(input) {\n  if (input) {\n    return input;\n  }\n  if (!input) {\n    return 0;\n  }\n}",
      "function deeper(input) {\n  if (input) {\n    if (input.value) {\n      return input.value;\n    }\n  }\n}",
      "function alternative(input) {\n  if (input) {\n    return input;\n  } else {\n    return 0;\n  }\n}",
      "function loop(input) {\n  for (const item of input) {\n    consume(item);\n  }\n}",
      "function condition(input) {\n  if (\n    input\n  ) {\n    return input;\n  }\n}",
      "function object(input) {\n  const value = {\n    input\n  };\n}",
      "function template(input) {\n  return `value ${input}`;\n}",
      "function blocked(input) {\n  /* comment */\n  return input;\n}",
      "const arrow = (input) => {\n  return input;\n}",
      "class Box {\n  value = 1;\n}",
      `${source}\nconst notAFunction = true;\n`
    ]) {
      expect(isLineLocalFunctionScript(unsafe)).toBeFalse();
    }
  });

  test("keeps safe TypeScript streaming prefixes byte-identical to full highlighting", () => {
    const source = [
      "const answer: number = 42;",
      "const label: string = \"value\";",
      "const matcher: RegExp = /foo\\/bar/gi;",
      "function double(input: number): number { return input * 2; }",
      "// line-local comment",
      "console.log(label, matcher, double(answer));"
    ].join("\n");

    for (const scheme of ["dark", "light"] as const) {
      const streamed = new CodeHighlighter(true, scheme);
      const full = new CodeHighlighter(true, scheme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        expect(streamed.highlight(prefix, "typescript"))
          .toEqual(full.highlight(prefix, "tsx"));
      }
      const internal = streamed as unknown as {
        activeTypescript?: { mode: string; source: string };
      };
      expect(internal.activeTypescript).toMatchObject({
        mode: "incremental",
        source
      });
    }
  });

  test("reuses complete TypeScript lines while only re-highlighting the partial tail", () => {
    const streamed = new CodeHighlighter(true);
    const full = new CodeHighlighter(true);
    let source = "const seed: number = 0;\n";
    expect(streamed.highlight(source, "ts")).toEqual(full.highlight(source, "tsx"));

    for (const chunk of [
      "const next",
      ": string = \"value\";\nconst matcher",
      ": RegExp = /next+/g;\n",
      "console.log(seed, next, matcher);"
    ]) {
      source += chunk;
      expect(streamed.highlight(source, "ts")).toEqual(full.highlight(source, "tsx"));
    }

    const internal = streamed as unknown as {
      activeTypescript?: {
        lines?: string[];
        mode: string;
        source: string;
      };
      cache: Map<string, unknown>;
    };
    expect(internal.activeTypescript?.mode).toBe("incremental");
    expect((internal.activeTypescript?.source.length ?? 0)
      + (internal.activeTypescript?.lines ?? []).reduce((total, line) => total + line.length, 0))
      .toBeLessThanOrEqual(ACTIVE_TYPESCRIPT_HIGHLIGHT_MAX_CHARACTERS);
    expect(internal.cache.size).toBe(0);
  });

  test("reuses line-local body rows inside one still-open TypeScript function", () => {
    const source = [
      "export async function generated(input: number): Promise<number> {",
      "  const doubled: number = input * 2;",
      "  // line-local comment",
      "  const label: string = \"中文 ✅\";",
      "  const matcher: RegExp = /value+/g;",
      "  await Promise.resolve(label);",
      "  return matcher.test(label) ? doubled : input;"
    ].join("\n");

    expect(isSingleOpenScriptFunction(source)).toBeTrue();
    for (const scheme of ["dark", "light"] as const) {
      const streamed = new CodeHighlighter(true, scheme);
      const full = new CodeHighlighter(true, scheme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        expect(streamed.highlight(prefix, "typescript"))
          .toEqual(full.highlight(prefix, "tsx"));
      }
      const internal = streamed as unknown as {
        activeTypescript?: {
          lines?: string[];
          mode: string;
          stableLines?: string[];
          strategy?: string;
        };
      };
      expect(internal.activeTypescript).toMatchObject({
        mode: "incremental",
        strategy: "lines"
      });
      expect(internal.activeTypescript?.stableLines?.length).toBe(6);

      const closed = `${source}\n}\n`;
      expect(streamed.highlight(closed, "typescript"))
        .toEqual(full.highlight(closed, "tsx"));
      expect(internal.activeTypescript).toMatchObject({
        mode: "incremental",
        strategy: "top-level"
      });
    }
  });

  test("rejects contextual or non-function single-open TypeScript bodies", () => {
    const sources = [
      "function open(): void {\n  /* block starts\n  still open",
      "function open(): void {\n  const template = `first\n  second",
      "function open(\n  input: number\n): void {\n  return;",
      "function open(): void {\n  if (ready) {\n    console.log(ready);",
      "function open(): void {\n  const value = {\n    ready: true",
      "class Open {\n  value = 1;",
      "const open = (): void => {\n  const value = 1;",
      "function open(): void {\n  const value = (1;"
    ];

    for (const source of sources) {
      expect(isSingleOpenScriptFunction(source)).toBeFalse();
      const streamed = new CodeHighlighter(true);
      expect(streamed.highlight(source, "typescript"))
        .toEqual(new CodeHighlighter(true).highlight(source, "tsx"));
      const internal = streamed as unknown as {
        activeTypescript?: { mode: string };
      };
      expect(internal.activeTypescript?.mode).toBe("fallback");
    }
  });

  test("reuses blank-separated multiline TypeScript blocks byte-for-byte", () => {
    const source = [
      "function first(value: number): number {\n  return value + 1;\n}",
      "interface User {\n  id: string;\n  name: string;\n}",
      "const user = {\n  id: \"1\",\n  name: \"Ada\"\n};",
      "class Box<T> {\n  value: T;\n  constructor(value: T) { this.value = value; }\n}"
    ].join("\n\n");

    for (const scheme of ["dark", "light"] as const) {
      const streamed = new CodeHighlighter(true, scheme);
      const full = new CodeHighlighter(true, scheme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        expect(streamed.highlight(prefix, "typescript"))
          .toEqual(full.highlight(prefix, "tsx"));
      }
      const internal = streamed as unknown as {
        activeTypescript?: { mode: string; strategy?: string };
        cache: Map<string, unknown>;
      };
      expect(internal.activeTypescript?.mode).toBe("incremental");
      expect(["blocks", "top-level"]).toContain(internal.activeTypescript?.strategy ?? "");
      expect(internal.cache.size).toBeLessThanOrEqual(CODE_HIGHLIGHT_CACHE_MAX_ENTRIES);
    }
  });

  test("stabilizes adjacent top-level TypeScript blocks at closed line boundaries", () => {
    const source = [
      "function first(value: number): number {\n  return value + 1;\n}",
      "interface User {\n  id: string;\n  name: string;\n}",
      "const user = {\n  id: \"1\",\n  name: \"Ada\"\n};",
      "class Box<T> {\n  value: T;\n  constructor(value: T) { this.value = value; }\n}"
    ].join("\n");

    for (const scheme of ["dark", "light"] as const) {
      const streamed = new CodeHighlighter(true, scheme);
      const full = new CodeHighlighter(true, scheme);
      let prefix = "";
      for (const character of source) {
        prefix += character;
        expect(streamed.highlight(prefix, "typescript"))
          .toEqual(full.highlight(prefix, "tsx"));
      }
      const internal = streamed as unknown as {
        activeTypescript?: { mode: string; strategy?: string };
      };
      expect(internal.activeTypescript).toMatchObject({
        mode: "incremental",
        strategy: "top-level"
      });
    }
  });

  test("falls back for TypeScript constructs whose highlighting can cross lines", () => {
    const sources = [
      "/* open\nstill comment */",
      "const template = `first\nsecond`;",
      "const continued = \"first\\\nsecond\";",
      "interface User {\n  id: string;\n}",
      "const user = {\n  id: \"one\"\n};",
      "function open(): void {\n\n  console.log(\"not top-level\");\n}"
    ];

    for (const source of sources) {
      const streamed = new CodeHighlighter(true);
      expect(streamed.highlight(source, "typescript"))
        .toEqual(new CodeHighlighter(true).highlight(source, "tsx"));
      const internal = streamed as unknown as {
        activeTypescript?: { mode: string };
      };
      expect(internal.activeTypescript?.mode).toBe("fallback");
    }
  });

  test("keeps TSX on the full highlighter and clears active state on theme changes", () => {
    const source = "const first: number = 1;\nconst second: number = 2;";
    const tsx = new CodeHighlighter(true, "dark");
    tsx.highlight(source, "tsx");
    const tsxInternal = tsx as unknown as {
      activeTypescript?: { mode: string };
    };
    expect(tsxInternal.activeTypescript).toBeUndefined();

    const highlighter = new CodeHighlighter(true, "dark");
    const dark = highlighter.highlight(source, "typescript");
    let internal = highlighter as unknown as {
      activeTypescript?: { mode: string };
    };
    expect(internal.activeTypescript?.mode).toBe("incremental");
    highlighter.setColorScheme("light");
    internal = highlighter as unknown as {
      activeTypescript?: { mode: string };
    };
    expect(internal.activeTypescript).toBeUndefined();
    const light = highlighter.highlight(source, "typescript");
    expect(light).toEqual(new CodeHighlighter(true, "light").highlight(source, "tsx"));
    expect(light).not.toEqual(dark);
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
