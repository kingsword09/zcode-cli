import {
  Box,
  Markdown,
  Text
} from "@earendil-works/pi-tui";

import type { ZCodeTheme } from "./theme.ts";

export class ThinkingView extends Box {
  private text = "";
  private completed = false;

  constructor(private readonly theme: ZCodeTheme) {
    super(1, 0, theme.thinkingBackground);
  }

  append(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.rebuild();
  }

  complete(): void {
    if (this.completed) return;
    this.completed = true;
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();
    const title = this.completed
      ? `${this.theme.muted("◇")} ${this.theme.bold("Thought")}`
      : `${this.theme.accent("◇")} ${this.theme.bold("Thinking")} ${this.theme.muted("· active")}`;
    this.addChild(new Text(title, 0, 0));
    if (this.text.trim()) {
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
