import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme
} from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";

function ansi(code: string, enabled: boolean): (text: string) => string {
  return enabled ? (text) => `\x1b[${code}m${text}${RESET}` : (text) => text;
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
  editor: EditorTheme;
  markdown: MarkdownTheme;
  select: SelectListTheme;
}

export function createTheme(enabled: boolean): ZCodeTheme {
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
      underline
    }
  };
}
