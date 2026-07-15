import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component
} from "@earendil-works/pi-tui";

import { attachmentSummary, type PromptImageAttachment } from "./attachments.ts";
import type { ZCodeTheme } from "./theme.ts";

export interface AttachmentBarCallbacks {
  onExit: () => void;
  onRemove: (index: number) => void;
  onRender: () => void;
}

const horizontalPadding = 1;

function firstFitting(candidates: string[], width: number): string {
  return candidates.find((candidate) => visibleWidth(candidate) <= width)
    ?? truncateToWidth(candidates.at(-1) ?? "", width, "…");
}

export class AttachmentBar implements Component {
  private attachments: PromptImageAttachment[] = [];
  private active = false;
  private selectedIndex = 0;

  constructor(
    private readonly theme: ZCodeTheme,
    private readonly callbacks: AttachmentBarCallbacks
  ) {}

  setAttachments(attachments: PromptImageAttachment[]): void {
    this.attachments = [...attachments];
    if (this.attachments.length === 0) {
      this.active = false;
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = Math.min(this.selectedIndex, this.attachments.length - 1);
  }

  activate(index = this.attachments.length - 1): boolean {
    if (this.attachments.length === 0) return false;
    this.active = true;
    this.selectedIndex = Math.max(0, Math.min(index, this.attachments.length - 1));
    return true;
  }

  deactivate(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  handleInput(data: string): void {
    if (!this.active) return;
    if (matchesKey(data, "left")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "right")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "home")) {
      this.selectedIndex = 0;
      this.callbacks.onRender();
      return;
    }
    if (matchesKey(data, "end")) {
      this.selectedIndex = Math.max(0, this.attachments.length - 1);
      this.callbacks.onRender();
      return;
    }
    if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
      this.callbacks.onRemove(this.selectedIndex);
      return;
    }
    if (matchesKey(data, "down")
      || matchesKey(data, "escape")
      || matchesKey(data, "ctrl+c")
      || matchesKey(data, "enter")) {
      this.callbacks.onExit();
    }
  }

  render(width: number): string[] {
    if (this.attachments.length === 0) return [];
    if (width <= 0) return [""];
    const innerWidth = Math.max(0, width - horizontalPadding * 2);
    if (innerWidth === 0) return [""];

    const tokens = this.attachments.map((_, index) => this.token(index));
    const tokenLine = `${this.theme.muted("Images")} ${tokens.join(" ")}`;
    const primary = visibleWidth(tokenLine) <= innerWidth
      ? this.withInactiveHint(tokenLine, innerWidth)
      : this.compactLine(innerWidth);
    const lines = [` ${primary}`];

    if (this.active) {
      const hints = [
        "←/→ select · Backspace/Delete remove · ↓/Esc return",
        "←/→ select · Del remove · Esc return",
        "←/→ · Del · Esc"
      ].map((hint) => this.theme.muted(hint));
      lines.push(` ${firstFitting(hints, innerWidth)}`);
    }
    return lines;
  }

  invalidate(): void {}

  private moveSelection(delta: -1 | 1): void {
    const count = this.attachments.length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
    this.callbacks.onRender();
  }

  private token(index: number): string {
    const label = `[Image #${index + 1}]`;
    if (this.active && index === this.selectedIndex) {
      return `${this.theme.select.selectedPrefix("›")} ${this.theme.select.selectedText(label)}`;
    }
    return `${this.theme.muted("·")} ${this.theme.bold(label)}`;
  }

  private withInactiveHint(line: string, width: number): string {
    if (this.active) return line;
    const hints = [" · ↑ manage", " · ↑", ""];
    const suffix = hints.find((hint) => visibleWidth(`${line}${hint}`) <= width) ?? "";
    return `${line}${this.theme.muted(suffix)}`;
  }

  private compactLine(width: number): string {
    if (this.active) {
      return firstFitting([
        `${this.theme.muted(`Images ${this.selectedIndex + 1}/${this.attachments.length}`)} ${this.token(this.selectedIndex)}`,
        `${this.theme.select.selectedPrefix("›")} ${this.theme.muted(`Image ${this.selectedIndex + 1}/${this.attachments.length}`)}`
      ], width);
    }

    const summary = attachmentSummary(this.attachments);
    const count = `${this.attachments.length} image${this.attachments.length === 1 ? "" : "s"}`;
    return firstFitting([
      this.theme.muted(`${summary} · ↑ manage`),
      this.theme.muted(`${count} · ↑ manage`),
      this.theme.muted(count)
    ], width);
  }
}
