import { sanitizeTerminalText } from "./terminal-text.ts";

// Mirrors opencode's "OC | <first message>" terminal title so hosts (Orca,
// terminal emulators) show a content-derived label instead of the process name.
export const SESSION_TITLE_PREFIX = "ZC | ";

export const MAX_SESSION_TITLE_CHARS = 50;

export function sessionTitleFromFirstMessage(message: string): string | null {
  const normalized = sanitizeTerminalText(message).replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return null;
  }
  const characters = Array.from(normalized);
  if (characters.length <= MAX_SESSION_TITLE_CHARS) {
    return normalized;
  }
  return `${characters.slice(0, MAX_SESSION_TITLE_CHARS).join("")}…`;
}

export function emitSessionTerminalTitle(
  stream: { isTTY?: boolean; write: (chunk: string) => void } | undefined,
  title: string
): void {
  if (!stream?.isTTY) return;
  // Empty title clears the terminal title, restoring the host's default label.
  stream.write(title ? `\x1b]0;${SESSION_TITLE_PREFIX}${title}\x07` : "\x1b]0;\x07");
}
