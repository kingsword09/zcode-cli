import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { formatElapsed } from "./turn-status.ts";
import type { ZCodeTheme } from "./theme.ts";

export function workedDurationLabel(elapsedMilliseconds: number): string | undefined {
  if (Math.floor(elapsedMilliseconds / 1_000) <= 60) return undefined;
  return `Worked for ${formatElapsed(elapsedMilliseconds)}`;
}

/** Codex-style settled-work divider retained in the transcript after the task group ends. */
export class WorkDurationView implements Component {
  private readonly label?: string;

  constructor(
    elapsedMilliseconds: number,
    private readonly theme: ZCodeTheme
  ) {
    this.label = workedDurationLabel(elapsedMilliseconds);
  }

  render(width: number): string[] {
    if (!this.label || width <= 0) return [];
    const available = Math.max(1, width - 1);
    const content = `─ ${this.label} ─`;
    const line = content.length >= available
      ? truncateToWidth(content, available)
      : `${content}${"─".repeat(available - content.length)}`;
    return [` ${this.theme.muted(line)}`];
  }

  invalidate(): void {}
}
