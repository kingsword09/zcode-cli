import {
  Box,
  Markdown,
  Text
} from "@earendil-works/pi-tui";

import type { ZCodeTheme } from "./theme.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";

const maxLiveThinkingLines = 24;
// Keep an unbroken physical line from expanding into an unbounded wrapped view.
const maxLiveThinkingCharacters = 4_096;

function safeCutStart(value: string, requested: number): number {
  let start = Math.max(0, Math.min(value.length, requested));
  if (start > 0 && start < value.length) {
    const before = value.charCodeAt(start - 1);
    const current = value.charCodeAt(start);
    if (before >= 0xd800 && before <= 0xdbff
      && current >= 0xdc00 && current <= 0xdfff) {
      start += 1;
    }
  }
  return start;
}

function safeSuffixStart(value: string, maximumCharacters: number): number {
  return safeCutStart(value, value.length - maximumCharacters);
}

/** Keeps the visible streaming window bounded without copying the full trace. */
class ThinkingTailBuffer {
  private lines: string[] = [""];
  private length = 0;
  private cachedValue?: string;

  replace(text: string): void {
    const start = safeSuffixStart(text, maxLiveThinkingCharacters);
    const suffix = text.slice(start);
    const lines = suffix.split("\n");
    if (lines.length > maxLiveThinkingLines) lines.splice(0, lines.length - maxLiveThinkingLines);
    this.lines = lines;
    this.length = this.lines.join("\n").length;
    this.cachedValue = undefined;
  }

  append(delta: string): void {
    if (!delta) return;
    if (delta.indexOf("\n") < 0) {
      const last = this.lines.length - 1;
      this.lines[last] = `${this.lines[last] ?? ""}${delta}`;
      this.length += delta.length;
      if (this.length > maxLiveThinkingCharacters) this.trim();
      this.cachedValue = undefined;
      return;
    }
    const parts = delta.split("\n");
    const last = this.lines.length - 1;
    this.lines[last] = `${this.lines[last] ?? ""}${parts[0] ?? ""}`;
    for (let index = 1; index < parts.length; index += 1) this.lines.push(parts[index]!);
    this.length += delta.length;
    if (this.lines.length > maxLiveThinkingLines || this.length > maxLiveThinkingCharacters) {
      this.trim();
    }
    this.cachedValue = undefined;
  }

  value(): string {
    if (this.cachedValue === undefined) this.cachedValue = this.lines.join("\n");
    return this.cachedValue;
  }

  private trim(): void {
    if (this.lines.length > maxLiveThinkingLines) {
      const removed = this.lines.splice(0, this.lines.length - maxLiveThinkingLines);
      this.length -= removed.reduce((total, line) => total + line.length + 1, 0);
    }
    while (this.length > maxLiveThinkingCharacters && this.lines.length > 0) {
      const first = this.lines[0]!;
      const separatorLength = this.lines.length > 1 ? 1 : 0;
      const removable = first.length + separatorLength;
      const excess = this.length - maxLiveThinkingCharacters;
      if (removable <= excess) {
        this.lines.shift();
        this.length -= removable;
        if (this.lines.length === 0) this.lines.push("");
        continue;
      }
      const start = safeCutStart(first, excess);
      this.lines[0] = first.slice(start);
      this.length -= start;
      break;
    }
  }
}

export class ThinkingView extends Box {
  private text = "";
  private hasVisibleText = false;
  private completed = false;
  private expanded = false;
  private dirty = false;
  private readonly liveTail = new ThinkingTailBuffer();

  constructor(private readonly theme: ZCodeTheme) {
    super(1, 0);
  }

  append(delta: string): void {
    if (!delta) return;
    const sanitized = sanitizeTerminalText(delta, { preserveSgr: false });
    if (!sanitized) return;
    this.completed = false;
    this.hasVisibleText ||= sanitized.trim().length > 0;
    this.text += sanitized;
    this.liveTail.append(sanitized);
    this.dirty = true;
  }

  setText(text: string): void {
    const sanitized = sanitizeTerminalText(text, { preserveSgr: false });
    if (this.text === sanitized) return;
    if (sanitized.startsWith(this.text)) {
      const delta = sanitized.slice(this.text.length);
      this.liveTail.append(delta);
      this.hasVisibleText ||= delta.trim().length > 0;
    } else {
      this.liveTail.replace(sanitized);
      this.hasVisibleText = sanitized.trim().length > 0;
    }
    this.text = sanitized;
    this.dirty = true;
  }

  complete(): void {
    if (this.completed) return;
    this.completed = true;
    this.dirty = true;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.dirty = true;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasHiddenContent(): boolean {
    return this.completed && this.hasVisibleText && !this.expanded;
  }

  getSearchText(): string {
    return this.text;
  }

  override render(width: number): string[] {
    if (this.dirty) {
      this.rebuild();
      this.dirty = false;
    }
    return super.render(width);
  }

  private rebuild(): void {
    this.clear();
    const title = this.completed
      ? `${this.theme.muted("◇")} ${this.theme.bold("Thought")}${this.hasVisibleText && !this.expanded ? this.theme.muted(" · Ctrl+O to expand") : ""}`
      : `${this.theme.accent("◇")} ${this.theme.bold("Thinking")} ${this.theme.muted("· active")}`;
    this.addChild(new Text(title, 0, 0));
    if (this.hasVisibleText && (!this.completed || this.expanded)) {
      const body = this.completed || this.expanded ? this.text : this.liveTail.value();
      this.addChild(new Markdown(
        body,
        1,
        0,
        this.theme.markdown,
        { color: this.theme.muted, italic: true }
      ));
    }
  }
}
