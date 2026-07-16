import { extname } from "node:path";

import { highlight, supportsLanguage, type Theme } from "cli-highlight";

import type { ZCodeColorScheme } from "./color-scheme.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";

export const CODE_HIGHLIGHT_CACHE_MAX_ENTRIES = 128;
export const CODE_HIGHLIGHT_CACHE_MAX_CHARACTERS = 2_000_000;
export const ACTIVE_TYPESCRIPT_HIGHLIGHT_MAX_CHARACTERS = 2_000_000;
const maxHighlightCharacters = 100_000;
const plainLanguages = new Set(["", "text", "txt", "plain", "plaintext", "none"]);

const languageAliases: Record<string, string> = {
  cjs: "javascript",
  h: "c",
  hpp: "cpp",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml"
};

const reset = "\x1b[0m";
function sgr(code: string): (text: string) => string {
  const open = `\x1b[${code}m`;
  return (text) => `${open}${text.replaceAll(reset, `${reset}${open}`)}${reset}`;
}

const terminalThemes: Record<ZCodeColorScheme, Theme> = {
  dark: {
    keyword: sgr("1;38;5;75"),
    built_in: sgr("38;5;81"),
    type: sgr("38;5;117"),
    literal: sgr("38;5;75"),
    number: sgr("38;5;215"),
    regexp: sgr("38;5;203"),
    string: sgr("38;5;179"),
    class: sgr("1;38;5;117"),
    function: sgr("38;5;221"),
    title: sgr("38;5;221"),
    comment: sgr("3;38;5;247"),
    doctag: sgr("38;5;109"),
    meta: sgr("38;5;247"),
    section: sgr("1;38;5;75"),
    tag: sgr("38;5;109"),
    name: sgr("38;5;75"),
    attr: sgr("38;5;117"),
    attribute: sgr("38;5;117"),
    variable: sgr("38;5;203"),
    symbol: sgr("38;5;215"),
    bullet: sgr("38;5;75"),
    addition: sgr("38;5;78"),
    deletion: sgr("38;5;203")
  },
  light: {
    keyword: sgr("1;38;5;25"),
    built_in: sgr("38;5;24"),
    type: sgr("38;5;24"),
    literal: sgr("38;5;90"),
    number: sgr("38;5;90"),
    regexp: sgr("38;5;160"),
    string: sgr("38;5;94"),
    class: sgr("1;38;5;24"),
    function: sgr("38;5;25"),
    title: sgr("38;5;25"),
    comment: sgr("3;38;5;242"),
    doctag: sgr("38;5;24"),
    meta: sgr("38;5;242"),
    section: sgr("1;38;5;25"),
    tag: sgr("38;5;24"),
    name: sgr("38;5;25"),
    attr: sgr("38;5;94"),
    attribute: sgr("38;5;94"),
    variable: sgr("38;5;160"),
    symbol: sgr("38;5;90"),
    bullet: sgr("38;5;25"),
    addition: sgr("38;5;22"),
    deletion: sgr("38;5;160")
  }
};

function normalizedLanguage(value?: string): string | undefined {
  const raw = rawLanguage(value);
  if (plainLanguages.has(raw)) return undefined;
  const candidate = languageAliases[raw] ?? raw;
  return supportsLanguage(candidate) ? candidate : undefined;
}

function rawLanguage(value?: string): string {
  let raw = value?.trim().toLowerCase() ?? "";
  if (raw.startsWith("{") && raw.endsWith("}")) raw = raw.slice(1, -1).trim();
  if (raw.startsWith(".")) raw = raw.slice(1);
  return raw;
}

function isStreamingTypescriptLanguage(value?: string): boolean {
  const raw = rawLanguage(value);
  return raw === "ts" || raw === "typescript";
}

type ScriptDelimiter = "(" | "[" | "{";

function scriptDelimiterStack(source: string): ScriptDelimiter[] | undefined {
  const delimiters: ScriptDelimiter[] = [];
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  let lineComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (quote) {
      if (character === "\n") return undefined;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      delimiters.push(character);
      continue;
    }
    if (character !== ")" && character !== "]" && character !== "}") continue;
    const opening = delimiters.pop();
    if ((character === ")" && opening !== "(")
      || (character === "]" && opening !== "[")
      || (character === "}" && opening !== "{")) {
      return undefined;
    }
  }
  return quote === undefined ? delimiters : undefined;
}

function hasBalancedScriptDelimiters(source: string): boolean {
  return scriptDelimiterStack(source)?.length === 0;
}

function hasUnsafeScriptContinuation(source: string): boolean {
  return source.includes("`") || source.includes("/*") || source.includes("*/")
    || /\\\s*(?:\n|$)/u.test(source);
}

/**
 * A completed physical line is reused only when it cannot leave highlight.js
 * in a contextual mode for the following line. The final partial line may be
 * incomplete because it is always highlighted again on the next append.
 */
function isLineLocalScriptSuffix(source: string): boolean {
  if (hasUnsafeScriptContinuation(source)) return false;
  const lines = source.split("\n");
  lines.pop();
  return lines.every((line) => hasBalancedScriptDelimiters(line));
}

export function isLineLocalScript(source: string): boolean {
  return source.includes("\n") && isLineLocalScriptSuffix(source);
}

function isBlankSeparatedTypescriptSuffix(source: string): boolean {
  if (hasUnsafeScriptContinuation(source)) return false;
  const blocks = source.split("\n\n");
  blocks.pop();
  return blocks.every((block) => Boolean(block) && hasBalancedScriptDelimiters(block));
}

function isBlankSeparatedTypescript(source: string): boolean {
  return source.includes("\n\n") && isBlankSeparatedTypescriptSuffix(source);
}

interface TypeScriptTopLevelChunks {
  completed: string[];
  partial: string;
}

function topLevelTypeScriptChunks(source: string): TypeScriptTopLevelChunks | undefined {
  if (hasUnsafeScriptContinuation(source)) return undefined;
  const completed: string[] = [];
  const delimiters: string[] = [];
  let chunkStart = 0;
  let escaped = false;
  let lineComment = false;
  let lineCommentStart: number | undefined;
  let lineStart = 0;
  let quote: "\"" | "'" | undefined;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (lineComment) {
      if (character !== "\n") continue;
      lineComment = false;
    } else if (quote) {
      if (character === "\n") return undefined;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    } else if (character === "\"" || character === "'") {
      quote = character;
      continue;
    } else if (character === "/" && source[index + 1] === "/") {
      lineComment = true;
      lineCommentStart = index;
      index += 1;
      continue;
    } else if (character === "(" || character === "[" || character === "{") {
      delimiters.push(character);
      continue;
    } else if (character === ")" || character === "]" || character === "}") {
      const opening = delimiters.pop();
      if ((character === ")" && opening !== "(")
        || (character === "]" && opening !== "[")
        || (character === "}" && opening !== "{")) {
        return undefined;
      }
      continue;
    }

    if (character !== "\n") continue;
    const codeEnd = lineCommentStart ?? index;
    const lineCode = source.slice(lineStart, codeEnd).trimEnd();
    if (delimiters.length === 0
      && (!lineCode || lineCode.endsWith(";") || lineCode.endsWith("}"))) {
      completed.push(source.slice(chunkStart, index));
      chunkStart = index + 1;
    }
    lineCommentStart = undefined;
    lineStart = index + 1;
  }

  return {
    completed,
    partial: source.slice(chunkStart)
  };
}

function isTopLevelTypescript(source: string): boolean {
  const chunks = topLevelTypeScriptChunks(source);
  return chunks?.completed.some((chunk) => chunk.includes("\n")) === true;
}

const singleOpenFunctionHeader = /^(?: {0,3})(?:(?:export|default|async)\s+)*function(?:\s*\*)?\s+[A-Za-z_$][\w$]*[^{]*\{\s*$/u;
const singleOpenIfHeader = /^ {0,3}if\s*\([^{}]*\)\s*\{\s*$/u;

type SingleFunctionBodyState = "closed" | "open";

export function isSingleFunctionScriptHeader(source: string): boolean {
  const delimiters = singleOpenFunctionHeader.test(source)
    ? scriptDelimiterStack(source)
    : undefined;
  return delimiters?.length === 1 && delimiters[0] === "{";
}

function isSingleIfScriptHeader(source: string): boolean {
  const delimiters = singleOpenIfHeader.test(source)
    ? scriptDelimiterStack(source)
    : undefined;
  return delimiters?.length === 1 && delimiters[0] === "{";
}

function prefersSingleFunctionLineStrategy(source: string): boolean {
  const headerEnd = source.indexOf("\n");
  if (headerEnd < 0
    || !isSingleFunctionScriptHeader(source.slice(0, headerEnd))) {
    return false;
  }
  let tail = source.length - 1;
  while (tail >= 0 && /\s/u.test(source[tail]!)) tail -= 1;
  return source[tail] !== "}";
}

function singleFunctionScriptBodyState(
  source: string
): SingleFunctionBodyState | undefined {
  if (!source.includes("\n") || hasUnsafeScriptContinuation(source)) return undefined;
  const lines = source.split("\n");
  const header = lines.shift();
  if (!header || !isSingleFunctionScriptHeader(header)) return undefined;

  const sourceStack = scriptDelimiterStack(source);
  const open = sourceStack?.length === 1 && sourceStack[0] === "{";
  const closed = sourceStack?.length === 0;
  if (!open && !closed) return undefined;

  const partial = lines.pop() ?? "";
  if (closed) {
    const closing = source.endsWith("\n") ? lines.pop() : partial;
    if (!closing || !/^ {0,3}\}\s*$/u.test(closing)) return undefined;
  }
  if (lines.length === 0
    || lines.some((line) => !line.trim() || !hasBalancedScriptDelimiters(line))) {
    return undefined;
  }
  return open ? "open" : "closed";
}

export function isLineLocalFunctionScript(
  source: string,
  allowPartialLastLine = false
): boolean {
  if (!source || hasUnsafeScriptContinuation(source)) return false;
  const lines = source.split("\n");
  let bodyLines = 0;
  let functions = 0;
  let ifBlocks = 0;
  let ifBodyLines = 0;
  let insideFunction = false;
  let insideIf = false;

  for (const [index, line] of lines.entries()) {
    const lastPartial = allowPartialLastLine && index === lines.length - 1;
    const completeHeader = !insideFunction && isSingleFunctionScriptHeader(line);
    const completeIfHeader = insideFunction && !insideIf && isSingleIfScriptHeader(line);
    const completeClosing = insideFunction && /^ {0,3}\}\s*$/u.test(line);
    if (lastPartial && !completeHeader && !completeIfHeader && !completeClosing) break;
    if (!insideFunction) {
      if (!completeHeader) return false;
      functions += 1;
      bodyLines = 0;
      ifBlocks = 0;
      ifBodyLines = 0;
      insideFunction = true;
      continue;
    }
    if (completeIfHeader) {
      if (ifBlocks > 0) return false;
      ifBlocks += 1;
      ifBodyLines = 0;
      insideIf = true;
      continue;
    }
    if (completeClosing) {
      if (insideIf) {
        if (ifBodyLines === 0) return false;
        insideIf = false;
        bodyLines += 1;
        continue;
      }
      if (bodyLines === 0) return false;
      insideFunction = false;
      continue;
    }
    if (!line.trim() || !hasBalancedScriptDelimiters(line)) return false;
    if (insideIf) ifBodyLines += 1;
    else bodyLines += 1;
  }
  return functions > 0;
}

export function isSingleOpenScriptFunction(source: string): boolean {
  return singleFunctionScriptBodyState(source) === "open";
}

export function isIncrementalTypescriptSource(source: string): boolean {
  if (isLineLocalScript(source)
    || isBlankSeparatedTypescript(source)
    || isLineLocalFunctionScript(source, true)) {
    return true;
  }
  const preferSingleFunction = prefersSingleFunctionLineStrategy(source);
  if (preferSingleFunction && singleFunctionScriptBodyState(source) !== undefined) return true;
  return isTopLevelTypescript(source)
    || (!preferSingleFunction && singleFunctionScriptBodyState(source) !== undefined);
}

export function languageForFilename(filePath: string): string | undefined {
  const filename = filePath.toLowerCase().split(/[\\/]/u).at(-1) ?? "";
  const special = filename === "dockerfile" ? "dockerfile"
    : filename === "makefile" ? "makefile"
      : filename === "bun.lock" ? "json5"
        : undefined;
  if (special && supportsLanguage(special)) return special;
  const extension = extname(filename).slice(1);
  return normalizedLanguage(extension);
}

interface ActiveTypescriptHighlight {
  lines?: string[];
  mode: "fallback" | "incremental";
  partialSource?: string;
  retryWhenSafe?: boolean;
  source: string;
  stableLines?: string[];
  strategy?: "blocks" | "lines" | "top-level";
}

interface IncrementalTypescriptHighlight extends ActiveTypescriptHighlight {
  lines: string[];
  mode: "incremental";
  partialSource: string;
  stableLines: string[];
  strategy: "blocks" | "lines" | "top-level";
}

export class CodeHighlighter {
  private readonly cache = new Map<string, { characters: number; lines: string[] }>();
  private cacheCharacters = 0;
  private activeTypescript?: ActiveTypescriptHighlight;

  constructor(
    private readonly enabled: boolean,
    private colorScheme: ZCodeColorScheme = "dark"
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  setColorScheme(colorScheme: ZCodeColorScheme): void {
    if (this.colorScheme === colorScheme) return;
    this.colorScheme = colorScheme;
    this.cache.clear();
    this.cacheCharacters = 0;
    this.activeTypescript = undefined;
  }

  highlight(code: string, language?: string): string[] {
    const sanitized = sanitizeTerminalText(code, { preserveSgr: false });
    const normalized = normalizedLanguage(language);
    if (!this.enabled || !normalized || sanitized.length > maxHighlightCharacters) {
      if (isStreamingTypescriptLanguage(language)) this.activeTypescript = undefined;
      return sanitized.replace(/\r/gu, "").split("\n");
    }

    const key = `${normalized}\u0000${sanitized}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.lines;
    }

    if (normalized === "typescript" && isStreamingTypescriptLanguage(language)
      && sanitized.includes("\n")) {
      return this.highlightTypescriptStream(sanitized);
    }

    const lines = this.highlightSource(sanitized, normalized);
    this.cacheResult(key, lines);
    return lines;
  }

  highlightFileLine(code: string, filePath: string): string {
    return this.highlight(code, languageForFilename(filePath))[0] ?? "";
  }

  private highlightSource(source: string, language: string): string[] {
    try {
      const rendered = highlight(source, {
        language,
        ignoreIllegals: true,
        theme: terminalThemes[this.colorScheme]
      });
      return sanitizeTerminalText(rendered, { preserveSgr: true })
        .replace(/\r/gu, "")
        .split("\n");
    } catch {
      return source.replace(/\r/gu, "").split("\n");
    }
  }

  private highlightTypescriptStream(source: string): string[] {
    const active = this.activeTypescript;
    if (active?.source === source && active.lines) return active.lines;

    if (!active || !source.startsWith(active.source)) {
      this.promoteActiveTypescript();
      return this.startTypescriptStream(source);
    }

    const suffix = `${active.partialSource ?? ""}${source.slice(active.source.length)}`;
    if (active.mode === "incremental") {
      if (active.strategy === "lines" && isLineLocalScriptSuffix(suffix)) {
        return this.appendTypescriptLines(source, suffix, active.stableLines ?? []);
      }
      if (active.strategy === "blocks" && isBlankSeparatedTypescriptSuffix(suffix)) {
        return this.appendTypescriptBlocks(source, suffix, active.stableLines ?? []);
      }
      if (active.strategy === "top-level") {
        const chunks = topLevelTypeScriptChunks(suffix);
        if (chunks) {
          return this.appendTypescriptTopLevel(
            source,
            chunks,
            active.stableLines ?? []
          );
        }
      }
    }

    const lines = this.highlightSource(source, "typescript");
    const retryWhenSafe = active.mode === "incremental" || active.retryWhenSafe === true;
    if (retryWhenSafe && isIncrementalTypescriptSource(source)) {
      return this.startTypescriptStream(source, lines);
    }
    this.activeTypescript = this.retainedActiveFallback(
      source,
      lines,
      retryWhenSafe
    );
    return lines;
  }

  private startTypescriptStream(
    source: string,
    expected = this.highlightSource(source, "typescript")
  ): string[] {
    const preferSingleFunction = prefersSingleFunctionLineStrategy(source);
    const candidate = isLineLocalScript(source)
      ? this.typescriptLineCandidate(source)
      : isBlankSeparatedTypescript(source)
        ? this.typescriptBlockCandidate(source)
        : preferSingleFunction && singleFunctionScriptBodyState(source) !== undefined
          ? this.typescriptLineCandidate(source)
          : isTopLevelTypescript(source)
            ? this.typescriptTopLevelCandidate(source)
            : !preferSingleFunction
              && singleFunctionScriptBodyState(source) !== undefined
              ? this.typescriptLineCandidate(source)
              : undefined;
    if (!candidate) {
      this.activeTypescript = this.retainedActiveFallback(source, expected, true);
      return expected;
    }

    if (!sameLines(candidate.lines, expected)
      || this.activeSize(source, candidate.lines) > ACTIVE_TYPESCRIPT_HIGHLIGHT_MAX_CHARACTERS) {
      this.activeTypescript = this.retainedActiveFallback(source, expected);
      return expected;
    }

    this.activeTypescript = {
      lines: candidate.lines,
      mode: "incremental",
      partialSource: candidate.partialSource,
      source,
      stableLines: candidate.stableLines,
      strategy: candidate.strategy
    };
    return expected;
  }

  private appendTypescriptLines(
    source: string,
    suffix: string,
    previousStableLines: string[]
  ): string[] {
    const suffixSources = suffix.split("\n");
    const suffixLines = suffixSources.map((line) => this.highlightSource(line, "typescript")[0] ?? "");
    const stableLines = [...previousStableLines, ...suffixLines.slice(0, -1)];
    const lines = [...stableLines, suffixLines.at(-1) ?? ""];
    this.retainIncrementalTypescript({
      lines,
      mode: "incremental",
      partialSource: suffixSources.at(-1) ?? "",
      source,
      stableLines,
      strategy: "lines"
    });
    return lines;
  }

  private appendTypescriptBlocks(
    source: string,
    suffix: string,
    previousStableLines: string[]
  ): string[] {
    const blocks = suffix.split("\n\n");
    const partialSource = blocks.pop() ?? "";
    const stableLines = [...previousStableLines];
    for (const block of blocks) {
      stableLines.push(...this.highlightSource(block, "typescript"), "");
    }
    const lines = [...stableLines, ...this.highlightSource(partialSource, "typescript")];
    this.retainIncrementalTypescript({
      lines,
      mode: "incremental",
      partialSource,
      source,
      stableLines,
      strategy: "blocks"
    });
    return lines;
  }

  private appendTypescriptTopLevel(
    source: string,
    chunks: TypeScriptTopLevelChunks,
    previousStableLines: string[]
  ): string[] {
    const stableLines = [...previousStableLines];
    for (const chunk of chunks.completed) {
      stableLines.push(...this.highlightSource(chunk, "typescript"));
    }
    const lines = [...stableLines, ...this.highlightSource(chunks.partial, "typescript")];
    this.retainIncrementalTypescript({
      lines,
      mode: "incremental",
      partialSource: chunks.partial,
      source,
      stableLines,
      strategy: "top-level"
    });
    return lines;
  }

  private typescriptLineCandidate(source: string): IncrementalTypescriptHighlight {
    const sources = source.split("\n");
    const lines = sources.map((line) => this.highlightSource(line, "typescript")[0] ?? "");
    return {
      lines,
      mode: "incremental",
      partialSource: sources.at(-1) ?? "",
      source,
      stableLines: lines.slice(0, -1),
      strategy: "lines"
    };
  }

  private typescriptBlockCandidate(source: string): IncrementalTypescriptHighlight {
    const blocks = source.split("\n\n");
    const partialSource = blocks.pop() ?? "";
    const stableLines: string[] = [];
    for (const block of blocks) {
      stableLines.push(...this.highlightSource(block, "typescript"), "");
    }
    return {
      lines: [...stableLines, ...this.highlightSource(partialSource, "typescript")],
      mode: "incremental",
      partialSource,
      source,
      stableLines,
      strategy: "blocks"
    };
  }

  private typescriptTopLevelCandidate(source: string): IncrementalTypescriptHighlight {
    const chunks = topLevelTypeScriptChunks(source)!;
    const stableLines: string[] = [];
    for (const chunk of chunks.completed) {
      stableLines.push(...this.highlightSource(chunk, "typescript"));
    }
    return {
      lines: [...stableLines, ...this.highlightSource(chunks.partial, "typescript")],
      mode: "incremental",
      partialSource: chunks.partial,
      source,
      stableLines,
      strategy: "top-level"
    };
  }

  private retainIncrementalTypescript(active: IncrementalTypescriptHighlight): void {
    this.activeTypescript = this.activeSize(active.source, active.lines)
      <= ACTIVE_TYPESCRIPT_HIGHLIGHT_MAX_CHARACTERS
      ? active
      : { mode: "fallback", source: active.source };
  }

  private retainedActiveFallback(
    source: string,
    lines: string[],
    retryWhenSafe = false
  ): ActiveTypescriptHighlight {
    return this.activeSize(source, lines) <= ACTIVE_TYPESCRIPT_HIGHLIGHT_MAX_CHARACTERS
      ? { lines, mode: "fallback", retryWhenSafe, source }
      : { mode: "fallback", retryWhenSafe, source };
  }

  private promoteActiveTypescript(): void {
    const active = this.activeTypescript;
    if (!active?.lines) return;
    this.cacheResult(`typescript\u0000${active.source}`, active.lines);
  }

  private activeSize(source: string, lines: readonly string[]): number {
    return source.length + lines.reduce((total, line) => total + line.length, 0);
  }

  private cacheResult(key: string, lines: string[]): void {
    const characters = key.length + lines.reduce((total, line) => total + line.length, 0);
    if (characters <= CODE_HIGHLIGHT_CACHE_MAX_CHARACTERS) {
      const existing = this.cache.get(key);
      if (existing) {
        this.cache.delete(key);
        this.cacheCharacters -= existing.characters;
      }
      this.cache.set(key, { characters, lines });
      this.cacheCharacters += characters;
    }
    while (this.cache.size > CODE_HIGHLIGHT_CACHE_MAX_ENTRIES
      || this.cacheCharacters > CODE_HIGHLIGHT_CACHE_MAX_CHARACTERS) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cacheCharacters -= oldest[1].characters;
    }
  }
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
