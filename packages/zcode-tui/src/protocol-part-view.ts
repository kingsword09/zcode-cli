import {
  Text,
  type Component
} from "@earendil-works/pi-tui";

import type { RestoredPart } from "./events.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import type { ZCodeTheme } from "./theme.ts";

const visiblePartTypes = new Set<RestoredPart["type"]>([
  "file",
  "retry",
  "compaction",
  "subagent",
  "agent"
]);

export function isVisibleProtocolPart(part: RestoredPart): boolean {
  return visiblePartTypes.has(part.type);
}

export class ProtocolPartView implements Component {
  private expanded = false;

  constructor(
    private readonly theme: ZCodeTheme,
    private part: RestoredPart
  ) {}

  update(part: RestoredPart): void {
    this.part = part;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasHiddenContent(): boolean {
    if (this.part.type === "file") return Boolean(this.part.url);
    if (this.part.type === "subagent") return Boolean(this.part.prompt || this.part.command || this.part.model);
    return false;
  }

  getSearchText(): string {
    if (this.part.type === "subagent") {
      return [this.part.text, this.part.prompt, this.part.command, this.part.model].filter(Boolean).join("\n");
    }
    if (this.part.type === "file") return [this.part.text, this.part.url, this.part.mime].filter(Boolean).join("\n");
    if (this.part.type === "retry" || this.part.type === "compaction" || this.part.type === "agent") {
      return this.part.text;
    }
    return "";
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = this.lines();
    return lines.length > 0 ? new Text(lines.join("\n"), 1, 0).render(width) : [];
  }

  private lines(): string[] {
    if (this.part.type === "file") {
      const label = sanitizeTerminalText(this.part.filename ?? this.part.url ?? "attachment", { preserveSgr: false });
      const details = [this.part.mime, this.expanded ? this.part.url : undefined]
        .filter((value): value is string => Boolean(value))
        .map((value) => sanitizeTerminalText(value, { preserveSgr: false }))
        .join(" · ");
      return [
        `${this.theme.muted("◇")} ${this.theme.bold("Attachment")} ${label}`,
        ...(details ? [this.theme.muted(`└ ${details}`)] : [])
      ];
    }
    if (this.part.type === "retry") {
      return [`${this.theme.warning("↻")} ${this.theme.bold("Retrying model request")} ${this.theme.muted(sanitizeTerminalText(this.part.text, { preserveSgr: false }))}`];
    }
    if (this.part.type === "compaction") {
      const reason = this.part.reason ? sanitizeTerminalText(this.part.reason, { preserveSgr: false }) : undefined;
      return [`${this.theme.muted("◇")} ${this.theme.bold("Conversation compacted")}${reason ? ` ${this.theme.muted(`· ${reason}`)}` : ""}`];
    }
    if (this.part.type === "subagent") {
      const label = sanitizeTerminalText(this.part.agent ?? "Agent", { preserveSgr: false });
      const details = [this.part.model, this.part.command]
        .filter((value): value is string => Boolean(value))
        .map((value) => sanitizeTerminalText(value, { preserveSgr: false }))
        .join(" · ");
      const description = sanitizeTerminalText(this.part.description ?? this.part.text, { preserveSgr: false });
      return [
        `${this.theme.accent("◇")} ${this.theme.bold(label)} ${this.theme.muted(`· ${description}`)}`,
        ...(details ? [this.theme.muted(`└ ${details}`)] : []),
        ...(this.expanded && this.part.prompt
          ? [this.theme.muted(sanitizeTerminalText(this.part.prompt, { preserveSgr: false }))]
          : [])
      ];
    }
    if (this.part.type === "agent") {
      return [`${this.theme.accent("◇")} ${this.theme.bold(sanitizeTerminalText(this.part.name ?? this.part.text, { preserveSgr: false }))}`];
    }
    return [];
  }
}
