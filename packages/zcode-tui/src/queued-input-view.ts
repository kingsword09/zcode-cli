import {
  truncateToWidth,
  visibleWidth,
  type Component
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./terminal-text.ts";
import type { ZCodeTheme } from "./theme.ts";
import type { InputQueueState } from "./input-queue.ts";

const maxVisibleInputs = 3;

export type QueuedInputViewState = InputQueueState;

function oneLine(value: string): string {
  return sanitizeTerminalText(value, { preserveSgr: false }).replace(/\s+/gu, " ").trim();
}

function firstFitting(candidates: string[], width: number): string {
  return candidates.find((candidate) => visibleWidth(candidate) <= width)
    ?? truncateToWidth(candidates.at(-1) ?? "", width, "…");
}

export class QueuedInputView implements Component {
  private pendingSteers: string[] = [];
  private queuedInputs: string[] = [];

  constructor(private readonly theme: ZCodeTheme) {}

  setState(state: QueuedInputViewState): void {
    this.pendingSteers = state.pendingSteers.map(oneLine).filter(Boolean);
    this.queuedInputs = state.queuedInputs.map(oneLine).filter(Boolean);
  }

  render(width: number): string[] {
    if (this.pendingSteers.length === 0 && this.queuedInputs.length === 0) return [];
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];

    if (this.pendingSteers.length > 0) {
      const hidden = Math.max(0, this.pendingSteers.length - maxVisibleInputs);
      const visible = this.pendingSteers.slice(-maxVisibleInputs);
      const summary = `${this.pendingSteers.length} waiting`;
      lines.push(
        ` ${this.theme.bold("Steering current turn")} ${this.theme.muted(`· ${summary}`)}`,
        ...visible.map((input) => `  ${this.theme.accent("↪")} ${this.theme.bold(input)}`)
      );
      if (hidden > 0) lines.splice(1, 0, this.theme.muted(`  … ${hidden} earlier`));
      lines.push(firstFitting([
        "  waiting for the next model step",
        "  waiting for model step",
        "  pending steer"
      ].map((candidate) => this.theme.muted(candidate)), safeWidth));
    }

    if (this.queuedInputs.length > 0) {
      const sectionStart = lines.length;
      const hidden = Math.max(0, this.queuedInputs.length - maxVisibleInputs);
      const visible = this.queuedInputs.slice(-maxVisibleInputs);
      const summary = `${this.queuedInputs.length} ${this.queuedInputs.length === 1 ? "input" : "inputs"}`;
      lines.push(
        ` ${this.theme.bold("Queued next turn")} ${this.theme.muted(`· ${summary}`)}`,
        ...visible.map((input) => `  ${this.theme.muted("↳")} ${this.theme.bold(input)}`)
      );
      if (hidden > 0) lines.splice(sectionStart + 1, 0, this.theme.muted(`  … ${hidden} earlier`));
      lines.push(firstFitting([
        "  Alt+Up / Shift+Left edit last",
        "  Alt+Up edit last",
        "  edit last queued input"
      ].map((candidate) => this.theme.muted(candidate)), safeWidth));
    }

    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  invalidate(): void {}
}
