import type { Component } from "@earendil-works/pi-tui";

import { RichMarkdown } from "./rich-markdown.ts";
import type { ZCodeTheme } from "./theme.ts";

export class AssistantStream {
  private current?: RichMarkdown;
  private currentText = "";
  private streamedText = "";

  constructor(
    private readonly theme: ZCodeTheme,
    private readonly addBlock: (component: Component) => void
  ) {}

  beginTurn(): void {
    this.current = undefined;
    this.currentText = "";
    this.streamedText = "";
  }

  breakSegment(): void {
    this.current = undefined;
    this.currentText = "";
  }

  append(delta: string): string {
    if (!delta) return this.streamedText;
    if (!this.current) {
      this.current = new RichMarkdown("", 1, this.theme);
      this.addBlock(this.current);
    }
    this.currentText += delta;
    this.streamedText += delta;
    this.current.setText(this.currentText);
    return this.streamedText;
  }

  reconcile(response: string): string {
    if (!this.streamedText) {
      this.append(response);
      return response;
    }

    if (response.startsWith(this.streamedText)) {
      this.append(response.slice(this.streamedText.length));
    } else if (!this.streamedText.endsWith(response)) {
      // Some runtimes return only the final assistant message after streaming
      // commentary around tools. Keep that authoritative response at the end.
      this.breakSegment();
      this.append(response);
    }
    return response;
  }
}
