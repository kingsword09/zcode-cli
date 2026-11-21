import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ZCodeTheme } from "./theme.ts";

/**
 * Bare `/help` content: the merged command list (runtime-provided commands via
 * the host + TUI-local commands like /status and /quota). Width-safe: every
 * line truncates to the dialog width, never wraps.
 */
export class HelpSummaryView implements Component {
  constructor(
    private readonly theme: ZCodeTheme,
    private readonly lines: string[],
    private readonly footnote: string | undefined = undefined
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const rendered = this.lines.map(line => truncateToWidth(line, safeWidth, "…"));
    if (this.footnote) rendered.push("", this.theme.muted(truncateToWidth(this.footnote, safeWidth, "…")));
    return rendered;
  }

  invalidate(): void {}
}
