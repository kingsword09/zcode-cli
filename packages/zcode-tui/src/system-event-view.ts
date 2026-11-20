import {
  Text,
  type Component
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText, truncateGraphemes } from "./terminal-text.ts";
import type { ZCodeTheme } from "./theme.ts";

export interface SystemEventData {
  tone: "error" | "warning" | "muted";
  title: string;
  summary?: string;
  detail?: string;
}

export class SystemEventView implements Component {
  private expanded = false;
  private readonly detailText?: string;
  private readonly previewText?: string;

  constructor(
    private readonly theme: ZCodeTheme,
    private readonly event: SystemEventData
  ) {
    this.detailText = event.detail
      ? sanitizeTerminalText(event.detail, { preserveSgr: false }).trim() || undefined
      : undefined;
    if (event.tone === "error") {
      const firstLine = this.detailText?.split("\n").find(line => line.trim())?.trim();
      this.previewText = firstLine ? truncateGraphemes(firstLine, 240) : undefined;
    }
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasHiddenContent(): boolean {
    return Boolean(this.detailText && this.detailText !== this.previewText) && !this.expanded;
  }

  getSearchText(): string {
    return [this.event.title, this.event.summary, this.event.detail].filter(Boolean).join("\n");
  }

  invalidate(): void {}

  render(width: number): string[] {
    const icon = this.event.tone === "error" ? this.theme.error("✗")
      : this.event.tone === "warning" ? this.theme.warning("↻")
        : this.theme.muted("◇");
    const title = sanitizeTerminalText(this.event.title, { preserveSgr: false });
    const summary = this.event.summary
      ? sanitizeTerminalText(this.event.summary, { preserveSgr: false })
      : undefined;
    const detail = this.detailText;
    const preview = this.previewText;
    const hint = this.hasHiddenContent() ? this.theme.muted(" · Ctrl+O to expand") : "";
    const lines = [
      `${icon} ${this.theme.bold(title)}${summary ? ` ${this.theme.muted(`· ${summary}`)}` : ""}${hint}`,
      ...(this.expanded && detail ? [detail] : preview ? [preview] : [])
    ];
    const background = this.event.tone === "error" ? this.theme.toolErrorBackground : undefined;
    return new Text(lines.join("\n"), 1, 0, background).render(width);
  }
}
