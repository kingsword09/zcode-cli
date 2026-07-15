import {
  Box,
  Markdown,
  Text
} from "@earendil-works/pi-tui";

import type { ZCodeTheme } from "./theme.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";

export class ThinkingView extends Box {
  private text = "";
  private completed = false;
  private expanded = false;

  constructor(private readonly theme: ZCodeTheme) {
    super(1, 0);
  }

  append(delta: string): void {
    if (!delta) return;
    this.text += sanitizeTerminalText(delta, { preserveSgr: false });
    this.rebuild();
  }

  setText(text: string): void {
    const sanitized = sanitizeTerminalText(text, { preserveSgr: false });
    if (this.text === sanitized) return;
    this.text = sanitized;
    this.rebuild();
  }

  complete(): void {
    if (this.completed) return;
    this.completed = true;
    this.rebuild();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.rebuild();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasHiddenContent(): boolean {
    return this.completed && Boolean(this.text.trim()) && !this.expanded;
  }

  getSearchText(): string {
    return this.text;
  }

  private rebuild(): void {
    this.clear();
    const title = this.completed
      ? `${this.theme.muted("◇")} ${this.theme.bold("Thought")}${this.text.trim() && !this.expanded ? this.theme.muted(" · Ctrl+O to expand") : ""}`
      : `${this.theme.accent("◇")} ${this.theme.bold("Thinking")} ${this.theme.muted("· active")}`;
    this.addChild(new Text(title, 0, 0));
    if (this.text.trim() && (!this.completed || this.expanded)) {
      this.addChild(new Markdown(
        this.text,
        1,
        0,
        this.theme.markdown,
        { color: this.theme.muted, italic: true }
      ));
    }
  }
}
