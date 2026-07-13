import {
  Text,
  truncateToWidth,
  type Component
} from "@earendil-works/pi-tui";

import type { ZCodeTheme } from "./theme.ts";
import { toolGroupKind } from "./tool-renderers.ts";
import type { ToolExecutionView } from "./tool-view.ts";

export class ToolGroupView implements Component {
  private readonly tools: ToolExecutionView[] = [];
  private expanded = false;

  constructor(private readonly theme: ZCodeTheme) {}

  addTool(tool: ToolExecutionView): void {
    this.tools.push(tool);
    tool.setExpanded(this.expanded);
  }

  removeTool(tool: ToolExecutionView): boolean {
    const index = this.tools.indexOf(tool);
    if (index < 0) return false;
    this.tools.splice(index, 1);
    return true;
  }

  get size(): number {
    return this.tools.length;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    for (const tool of this.tools) tool.setExpanded(expanded);
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasHiddenContent(): boolean {
    return !this.expanded && this.tools.length > 0;
  }

  getSearchText(): string {
    return this.tools.map((tool) => tool.getSearchText()).join("\n");
  }

  invalidate(): void {
    for (const tool of this.tools) tool.invalidate();
  }

  render(width: number): string[] {
    if (this.expanded) {
      const lines: string[] = [];
      for (const [index, tool] of this.tools.entries()) {
        if (index > 0) lines.push("");
        lines.push(...tool.render(width));
      }
      return lines;
    }

    const readCount = this.tools.filter((tool) => toolGroupKind(tool.getName()) === "read").length;
    const searchCount = this.tools.filter((tool) => toolGroupKind(tool.getName()) === "search").length;
    const active = this.tools.some((tool) => !tool.isTerminal());
    const failed = this.tools.some((tool) => ["failed", "error"].includes(tool.getState().toLowerCase()));
    const interrupted = this.tools.some((tool) => ["cancelled", "rejected", "interrupted"].includes(tool.getState().toLowerCase()));
    const parts: string[] = [];
    if (readCount > 0) parts.push(`${active ? "Reading" : "Read"} ${readCount} ${readCount === 1 ? "file" : "files"}`);
    if (searchCount > 0) parts.push(`${active ? "searching" : "searched"} ${searchCount} ${searchCount === 1 ? "pattern" : "patterns"}`);
    const latest = this.tools.at(-1)?.getSummary();
    const icon = failed
      ? this.theme.error("✗")
      : interrupted
        ? this.theme.warning("■")
        : active
          ? this.theme.accent("●")
          : this.theme.muted("○");
    const suffix = [
      latest && this.theme.muted(`⎿ ${latest}`),
      this.theme.muted("Ctrl+O to expand")
    ].filter(Boolean).join(" · ");
    const line = `${icon} ${parts.join(", ")}${active ? "…" : ""} · ${suffix}`;
    return new Text(truncateToWidth(line, Math.max(1, width)), 1, 0).render(width);
  }
}
