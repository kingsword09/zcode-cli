import { sanitizeTerminalText } from "../packages/zcode-tui/src/terminal-text.ts";

/** Plain text for PTY traces; keep output after both BEL- and ST-terminated controls. */
export function terminalOutputText(value: string): string {
  return sanitizeTerminalText(value.replaceAll("\r", ""));
}
