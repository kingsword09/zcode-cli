import { extname } from "node:path";

import { highlight, supportsLanguage, type Theme } from "cli-highlight";

import type { ZCodeColorScheme } from "./color-scheme.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";

const maxCacheEntries = 128;
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
  let raw = value?.trim().toLowerCase() ?? "";
  if (raw.startsWith("{") && raw.endsWith("}")) raw = raw.slice(1, -1).trim();
  if (raw.startsWith(".")) raw = raw.slice(1);
  if (plainLanguages.has(raw)) return undefined;
  const candidate = languageAliases[raw] ?? raw;
  return supportsLanguage(candidate) ? candidate : undefined;
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

export class CodeHighlighter {
  private readonly cache = new Map<string, string[]>();

  constructor(
    private readonly enabled: boolean,
    private colorScheme: ZCodeColorScheme = "dark"
  ) {}

  setColorScheme(colorScheme: ZCodeColorScheme): void {
    if (this.colorScheme === colorScheme) return;
    this.colorScheme = colorScheme;
    this.cache.clear();
  }

  highlight(code: string, language?: string): string[] {
    const sanitized = sanitizeTerminalText(code, { preserveSgr: false });
    const normalized = normalizedLanguage(language);
    if (!this.enabled || !normalized || sanitized.length > maxHighlightCharacters) {
      return sanitized.replace(/\r/gu, "").split("\n");
    }

    const key = `${normalized}\u0000${sanitized}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    let lines: string[];
    try {
      const rendered = highlight(sanitized, {
        language: normalized,
        ignoreIllegals: true,
        theme: terminalThemes[this.colorScheme]
      });
      lines = sanitizeTerminalText(rendered, { preserveSgr: true }).replace(/\r/gu, "").split("\n");
    } catch {
      lines = sanitized.replace(/\r/gu, "").split("\n");
    }
    this.cache.set(key, lines);
    if (this.cache.size > maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return lines;
  }

  highlightFileLine(code: string, filePath: string): string {
    return this.highlight(code, languageForFilename(filePath))[0] ?? "";
  }
}
