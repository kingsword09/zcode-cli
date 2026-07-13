import {
  Text,
  type Component
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./terminal-text.ts";
import type { ZCodeTheme } from "./theme.ts";

export interface SystemEventData {
  tone: "error" | "warning" | "muted";
  title: string;
  summary?: string;
  detail?: string;
}

export class SystemEventView implements Component {
  private expanded = false;

  constructor(
    private readonly theme: ZCodeTheme,
    private readonly event: SystemEventData
  ) {}

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasHiddenContent(): boolean {
    return Boolean(this.event.detail) && !this.expanded;
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
    const detail = this.event.detail
      ? sanitizeTerminalText(this.event.detail, { preserveSgr: false })
      : undefined;
    const hint = detail && !this.expanded ? this.theme.muted(" · Ctrl+O to expand") : "";
    const lines = [
      `${icon} ${this.theme.bold(title)}${summary ? ` ${this.theme.muted(`· ${summary}`)}` : ""}${hint}`,
      ...(detail && this.expanded ? [detail] : [])
    ];
    const background = this.event.tone === "error" ? this.theme.toolErrorBackground : undefined;
    return new Text(lines.join("\n"), 1, 0, background).render(width);
  }
}
