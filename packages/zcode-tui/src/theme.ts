import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme
} from "@earendil-works/pi-tui";

import { CodeHighlighter } from "./code-highlighter.ts";

const RESET = "\x1b[0m";

function ansi(code: string, enabled: boolean): (text: string) => string {
  if (!enabled) return (text) => text;
  const open = `\x1b[${code}m`;
  return (text) => `${open}${text.replaceAll(RESET, `${RESET}${open}`)}${RESET}`;
}

export interface ZCodeTheme {
  accent: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  error: (text: string) => string;
  muted: (text: string) => string;
  bold: (text: string) => string;
  userBackground: (text: string) => string;
  thinkingBackground: (text: string) => string;
  toolPendingBackground: (text: string) => string;
  toolSuccessBackground: (text: string) => string;
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
}

export function createTheme(enabled: boolean): ZCodeTheme {
  const codeHighlighter = new CodeHighlighter(enabled);
  const accent = ansi("38;5;75", enabled);
  const success = ansi("38;5;78", enabled);
  const warning = ansi("38;5;221", enabled);
  const error = ansi("38;5;203", enabled);
  const muted = ansi("38;5;244", enabled);
  const bold = ansi("1", enabled);
  const italic = ansi("3", enabled);
  const underline = ansi("4", enabled);
  const strikethrough = ansi("9", enabled);
  const code = ansi("38;5;117", enabled);
  const quote = ansi("38;5;109", enabled);
  const userBackground = ansi("48;5;236", enabled);
  const thinkingBackground = ansi("48;5;235", enabled);
  const toolPendingBackground = ansi("48;5;236", enabled);
  const toolSuccessBackground = ansi("48;5;234", enabled);
  const toolErrorBackground = ansi("48;5;52", enabled);
  const diffAddedLine = ansi("38;5;120;48;5;22", enabled);
  const diffRemovedLine = ansi("38;5;210;48;5;52", enabled);
  const diffHunkLine = ansi("38;5;117;48;5;24", enabled);
  const diffAddedWord = ansi("1;38;5;231;48;5;28", enabled);
  const diffRemovedWord = ansi("1;38;5;231;48;5;88", enabled);
  const searchMatch = enabled ? (text: string) => `\x1b[7m${text}\x1b[27m` : (text: string) => text;

  const select: SelectListTheme = {
    selectedPrefix: accent,
    selectedText: bold,
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
    userBackground,
    thinkingBackground,
    toolPendingBackground,
    toolSuccessBackground,
    toolErrorBackground,
    diffAddedLine,
    diffRemovedLine,
    diffHunkLine,
    diffAddedWord,
    diffRemovedWord,
    searchMatch,
    codeHighlighter,
    select,
    editor: {
      borderColor: accent,
      selectList: select
    },
    markdown: {
      heading: (text) => accent(bold(text)),
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
