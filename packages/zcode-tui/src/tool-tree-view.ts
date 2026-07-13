import {
  truncateToWidth,
  type Component
} from "@earendil-works/pi-tui";

import type { ZCodeTheme } from "./theme.ts";
import type { ToolExecutionView } from "./tool-view.ts";

const branchWidth = 5;

export class ToolTreeView implements Component {
  private readonly children: ToolTreeView[] = [];
  private expanded = false;

  constructor(
    private readonly theme: ZCodeTheme,
    readonly tool: ToolExecutionView
  ) {}

  addChild(child: ToolTreeView): void {
    if (child === this || this.children.includes(child)) return;
    this.children.push(child);
    child.setExpanded(this.expanded);
  }

  removeChild(child: ToolTreeView): boolean {
    const index = this.children.indexOf(child);
    if (index < 0) return false;
    this.children.splice(index, 1);
    return true;
  }

  getChildren(): readonly ToolTreeView[] {
    return this.children;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.tool.setExpanded(expanded);
    for (const child of this.children) child.setExpanded(expanded);
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasHiddenContent(): boolean {
    return this.tool.hasHiddenContent()
      || (!this.expanded && this.tool.isTerminal() && this.children.length > 0)
      || this.children.some((child) => child.hasHiddenContent());
  }

  getSearchText(): string {
    return [this.tool.getSearchText(), ...this.children.map((child) => child.getSearchText())].join("\n");
  }

  invalidate(): void {
    this.tool.invalidate();
    for (const child of this.children) child.invalidate();
  }

  render(width: number): string[] {
    const lines = [...this.tool.render(width)];
    if (this.children.length === 0) return lines;
    if (!this.expanded && this.tool.isTerminal()) {
      const count = this.descendantCount();
      lines.push(this.theme.muted(`  └─ ${count} child ${count === 1 ? "tool" : "tools"} · Ctrl+O to expand`));
      return lines;
    }

    const childWidth = Math.max(1, width - branchWidth);
    for (const [index, child] of this.children.entries()) {
      const last = index === this.children.length - 1;
      const firstPrefix = last ? "  └─ " : "  ├─ ";
      const nextPrefix = last ? "     " : "  │  ";
      const rendered = child.render(childWidth);
      for (const [lineIndex, line] of rendered.entries()) {
        const prefix = lineIndex === 0 ? firstPrefix : nextPrefix;
        lines.push(truncateToWidth(`${this.theme.muted(prefix)}${line}`, width));
      }
    }
    return lines;
  }

  private descendantCount(): number {
    return this.children.reduce((total, child) => total + 1 + child.descendantCount(), 0);
  }
}
