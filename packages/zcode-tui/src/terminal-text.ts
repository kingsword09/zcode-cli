import {
  truncateToWidth,
  wrapTextWithAnsi
} from "@earendil-works/pi-tui";

const ESC = "\x1b";
const BEL = "\x07";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isFinalByte(value: string | undefined): boolean {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function controlSequenceEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (isFinalByte(value[index])) return index + 1;
  }
  return value.length;
}

function stringSequenceEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === BEL) return index + 1;
    if (value[index] === ESC && value[index + 1] === "\\") return index + 2;
  }
  return value.length;
}

function safeSgr(sequence: string): boolean {
  return /^\x1b\[[0-9:;]*m$/u.test(sequence);
}

export interface SanitizeTerminalTextOptions {
  preserveSgr?: boolean;
}

/**
 * Keep printable content while preventing untrusted model or tool output from
 * issuing terminal commands. SGR is stripped by default and may be preserved
 * only for styling produced by trusted application code.
 */
export function sanitizeTerminalText(
  value: string,
  options: SanitizeTerminalTextOptions = {}
): string {
  const preserveSgr = options.preserveSgr ?? false;
  let output = "";

  for (let index = 0; index < value.length;) {
    const character = value[index]!;
    const code = character.charCodeAt(0);

    if (character === ESC) {
      const next = value[index + 1];
      if (next === "[") {
        const end = controlSequenceEnd(value, index + 2);
        const sequence = value.slice(index, end);
        if (preserveSgr && safeSgr(sequence)) output += sequence;
        index = end;
        continue;
      }
      if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
        index = stringSequenceEnd(value, index + 2);
        continue;
      }
      index += 1;
      continue;
    }

    if (code === 0x9b) {
      index = controlSequenceEnd(value, index + 1);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = stringSequenceEnd(value, index + 1);
      continue;
    }

    if (character === "\n" || character === "\t") {
      output += character;
      index += 1;
      continue;
    }
    if (character === "\r") {
      if (value[index + 1] !== "\n") output += "\n";
      index += 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      index += 1;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

/** Wrap styled application text without splitting ANSI sequences or graphemes. */
export function wrapTerminalText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines = wrapTextWithAnsi(value, safeWidth);
  return lines.length > 0 ? lines : [""];
}

/** Truncate printable text by terminal columns, preserving complete graphemes. */
export function truncateTerminalText(
  value: string,
  width: number,
  ellipsis = "…"
): string {
  return truncateToWidth(value, Math.max(1, Math.floor(width)), ellipsis);
}

/** Bound labels by user-perceived characters without splitting emoji clusters. */
export function truncateGraphemes(
  value: string,
  maximum: number,
  ellipsis = "…"
): string {
  const limit = Math.max(0, Math.floor(maximum));
  if (limit === 0) return "";
  const segments: string[] = [];
  for (const entry of graphemeSegmenter.segment(value)) {
    if (segments.length === limit) {
      const keep = Math.max(0, limit - (ellipsis ? 1 : 0));
      return `${segments.slice(0, keep).join("")}${ellipsis}`;
    }
    segments.push(entry.segment);
  }
  return value;
}

export function removeLastGrapheme(value: string): string {
  const segments = Array.from(graphemeSegmenter.segment(value), (entry) => entry.segment);
  segments.pop();
  return segments.join("");
}
