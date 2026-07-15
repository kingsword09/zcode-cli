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

function safeSgr(sequence: string): boolean {
  return /^\x1b\[[0-9:;]*m$/u.test(sequence);
}

export interface SanitizeTerminalTextOptions {
  preserveSgr?: boolean;
}

type SanitizerState = "text" | "escape" | "csi" | "string" | "string-escape";

/**
 * Incrementally strips terminal control sequences without leaking a sequence
 * split across transport chunks. The instance owns one logical text stream;
 * call finish() before reusing it for a new stream.
 */
export class StreamingTerminalTextSanitizer {
  private state: SanitizerState = "text";
  private sgrCandidate?: string;
  private skipLeadingLineFeed = false;
  private readonly preserveSgr: boolean;

  constructor(options: SanitizeTerminalTextOptions = {}) {
    this.preserveSgr = options.preserveSgr ?? false;
  }

  append(value: string): string {
    let output = "";

    for (let index = 0; index < value.length;) {
      const character = value[index]!;
      const code = character.charCodeAt(0);

      if (this.skipLeadingLineFeed) {
        this.skipLeadingLineFeed = false;
        if (character === "\n") {
          index += 1;
          continue;
        }
      }

      if (this.state === "escape") {
        if (character === "[") {
          this.state = "csi";
          this.sgrCandidate = this.preserveSgr ? `${ESC}[` : undefined;
          index += 1;
          continue;
        }
        if (character === "]" || character === "P" || character === "X"
          || character === "^" || character === "_") {
          this.state = "string";
          index += 1;
          continue;
        }
        this.state = "text";
        continue;
      }

      if (this.state === "csi") {
        if (this.sgrCandidate !== undefined) {
          if (isFinalByte(character)) {
            const sequence = `${this.sgrCandidate}${character}`;
            if (safeSgr(sequence)) output += sequence;
          } else if (/^[0-9:;]$/u.test(character)) {
            this.sgrCandidate += character;
          } else {
            this.sgrCandidate = undefined;
          }
        }
        if (isFinalByte(character)) {
          this.state = "text";
          this.sgrCandidate = undefined;
        }
        index += 1;
        continue;
      }

      if (this.state === "string") {
        if (character === BEL) this.state = "text";
        else if (character === ESC) this.state = "string-escape";
        index += 1;
        continue;
      }

      if (this.state === "string-escape") {
        if (character === "\\" || character === BEL) this.state = "text";
        else this.state = character === ESC ? "string-escape" : "string";
        index += 1;
        continue;
      }

      if (character === ESC) {
        this.state = "escape";
        index += 1;
        continue;
      }
      if (code === 0x9b) {
        this.state = "csi";
        this.sgrCandidate = undefined;
        index += 1;
        continue;
      }
      if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
        this.state = "string";
        index += 1;
        continue;
      }
      if (character === "\n" || character === "\t") {
        output += character;
        index += 1;
        continue;
      }
      if (character === "\r") {
        output += "\n";
        this.skipLeadingLineFeed = true;
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

  finish(): string {
    this.reset();
    return "";
  }

  reset(): void {
    this.state = "text";
    this.sgrCandidate = undefined;
    this.skipLeadingLineFeed = false;
  }
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
  const sanitizer = new StreamingTerminalTextSanitizer(options);
  return sanitizer.append(value) + sanitizer.finish();
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
