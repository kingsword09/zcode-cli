import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme
} from "@earendil-works/pi-tui";

import { CodeHighlighter } from "./code-highlighter.ts";
import type { ZCodeColorScheme } from "./color-scheme.ts";

const RESET = "\x1b[0m";

function ansi(code: () => string, enabled: boolean): (text: string) => string {
  if (!enabled) return (text) => text;
  return (text) => {
    const open = `\x1b[${code()}m`;
    return `${open}${text.replaceAll(RESET, `${RESET}${open}`)}${RESET}`;
  };
}

interface ThemePalette {
  accent: string;
  success: string;
  warning: string;
  error: string;
  muted: string;
  strong: string;
  code: string;
  quote: string;
  toolPendingSurface: string;
  toolErrorSurface: string;
  diffAddedLine: string;
  diffRemovedLine: string;
  diffHunkLine: string;
  diffAddedWord: string;
  diffRemovedWord: string;
}

const palettes: Record<ZCodeColorScheme, ThemePalette> = {
  dark: {
    accent: "38;5;75",
    success: "38;5;78",
    warning: "38;5;221",
    error: "38;5;203",
    muted: "38;5;247",
    strong: "1;38;5;252",
    code: "38;5;117",
    quote: "38;5;109",
    toolPendingSurface: "38;5;252;48;5;236",
    toolErrorSurface: "38;5;252;48;5;52",
    diffAddedLine: "38;5;120;48;5;22",
    diffRemovedLine: "38;5;210;48;5;52",
    diffHunkLine: "38;5;159;48;5;24",
    diffAddedWord: "1;38;5;231;48;5;28",
    diffRemovedWord: "1;38;5;231;48;5;88"
  },
  light: {
    accent: "38;5;25",
    success: "38;5;22",
    warning: "38;5;94",
    error: "38;5;160",
    muted: "38;5;242",
    strong: "1;38;5;236",
    code: "38;5;25",
    quote: "38;5;24",
    toolPendingSurface: "38;5;58;48;5;230",
    toolErrorSurface: "38;5;236;48;5;224",
    diffAddedLine: "38;5;22;48;5;194",
    diffRemovedLine: "38;5;88;48;5;224",
    diffHunkLine: "38;5;24;48;5;189",
    diffAddedWord: "1;38;5;22;48;5;157",
    diffRemovedWord: "1;38;5;88;48;5;217"
  }
};

type PaletteKey = keyof ThemePalette;

function paletteStyle(
  state: { colorScheme: ZCodeColorScheme },
  key: PaletteKey,
  enabled: boolean
): (text: string) => string {
  return ansi(() => palettes[state.colorScheme][key], enabled);
}

export interface ZCodeTheme {
  accent: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  error: (text: string) => string;
  muted: (text: string) => string;
  bold: (text: string) => string;
  toolPendingBackground: (text: string) => string;
  toolErrorBackground: (text: string) => string;
  diffAddedLine: (text: string) => string;
  diffRemovedLine: (text: string) => string;
  diffHunkLine: (text: string) => string;
  diffAddedWord: (text: string) => string;
  diffRemovedWord: (text: string) => string;
  searchMatch: (text: string) => string;
  codeHighlighter: CodeHighlighter;
  editor: EditorTheme;
  markdown: MarkdownTheme;
  select: SelectListTheme;
  setColorScheme: (colorScheme: ZCodeColorScheme) => void;
}

export function createTheme(enabled: boolean, initialColorScheme: ZCodeColorScheme = "dark"): ZCodeTheme {
  const state = { colorScheme: initialColorScheme };
  const codeHighlighter = new CodeHighlighter(enabled, initialColorScheme);
  const accent = paletteStyle(state, "accent", enabled);
  const success = paletteStyle(state, "success", enabled);
  const warning = paletteStyle(state, "warning", enabled);
  const error = paletteStyle(state, "error", enabled);
  const muted = paletteStyle(state, "muted", enabled);
  const bold = paletteStyle(state, "strong", enabled);
  const italic = ansi(() => "3", enabled);
  const underline = ansi(() => "4", enabled);
  const strikethrough = ansi(() => "9", enabled);
  const code = paletteStyle(state, "code", enabled);
  const quote = paletteStyle(state, "quote", enabled);
  const toolPendingBackground = paletteStyle(state, "toolPendingSurface", enabled);
  const toolErrorBackground = paletteStyle(state, "toolErrorSurface", enabled);
  const diffAddedLine = paletteStyle(state, "diffAddedLine", enabled);
  const diffRemovedLine = paletteStyle(state, "diffRemovedLine", enabled);
  const diffHunkLine = paletteStyle(state, "diffHunkLine", enabled);
  const diffAddedWord = paletteStyle(state, "diffAddedWord", enabled);
  const diffRemovedWord = paletteStyle(state, "diffRemovedWord", enabled);
  const searchMatch = enabled
    ? (text: string) => `\x1b[7m${text}\x1b[27m`
    : (text: string) => `⟦${text}⟧`;
  const accentBold = (text: string): string => bold(accent(text));
  const markdownHeading = (text: string): string => {
    if (!enabled) return text;
    // pi-tui applies bold before heading. Remove only bold's neutral foreground
    // so the semantic heading color remains active while retaining SGR 1.
    const strongOpen = `\x1b[${palettes[state.colorScheme].strong}m`;
    return accent(text.replaceAll(strongOpen, "\x1b[1m"));
  };

  const select: SelectListTheme = {
    selectedPrefix: accent,
    selectedText: accentBold,
    description: muted,
    scrollInfo: muted,
    noMatch: muted
  };

  return {
    accent,
    success,
    warning,
    error,
    muted,
    bold,
    toolPendingBackground,
    toolErrorBackground,
    diffAddedLine,
    diffRemovedLine,
    diffHunkLine,
    diffAddedWord,
    diffRemovedWord,
    searchMatch,
    codeHighlighter,
    setColorScheme: (colorScheme) => {
      if (state.colorScheme === colorScheme) return;
      state.colorScheme = colorScheme;
      codeHighlighter.setColorScheme(colorScheme);
    },
    select,
    editor: {
      borderColor: accent,
      selectList: select
    },
    markdown: {
      heading: markdownHeading,
      link: underline,
      linkUrl: muted,
      code,
      codeBlock: code,
      codeBlockBorder: muted,
      quote,
      quoteBorder: muted,
      hr: muted,
      listBullet: accent,
      bold,
      italic,
      strikethrough,
      underline,
      highlightCode: (source, language) => codeHighlighter.highlight(source, language)
    }
  };
}
