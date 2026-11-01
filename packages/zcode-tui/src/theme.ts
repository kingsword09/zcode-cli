import { CodeHighlighter } from "./code-highlighter.ts";
import type { ZCodeColorScheme } from "./color-scheme.ts";
import { createThemeStyles, type ZCodeThemeStyles } from "./theme-styles.ts";

export interface ZCodeTheme extends ZCodeThemeStyles {
  codeHighlighter: CodeHighlighter;
}

export function createTheme(enabled: boolean, initialColorScheme: ZCodeColorScheme = "dark"): ZCodeTheme {
  const styles = createThemeStyles(enabled, initialColorScheme);
  const codeHighlighter = new CodeHighlighter(enabled, initialColorScheme);
  return {
    ...styles,
    codeHighlighter,
    setColorScheme: (colorScheme) => {
      styles.setColorScheme(colorScheme);
      codeHighlighter.setColorScheme(colorScheme);
    },
    markdown: {
      ...styles.markdown,
      highlightCode: (source, language) => codeHighlighter.highlight(source, language)
    }
  };
}
