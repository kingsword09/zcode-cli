import {
  truncateToWidth,
  visibleWidth,
  type Component
} from "@earendil-works/pi-tui";

const horizontalPadding = 1;
const sectionGap = 2;

export class FooterBar implements Component {
  private left = "";
  private right?: string;
  private compactRight?: string;

  setContent(left: string, right?: string, compactRight?: string): void {
    this.left = left;
    this.right = right || undefined;
    this.compactRight = compactRight || undefined;
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    if (!this.left && !this.right) return [];
    const innerWidth = Math.max(0, width - horizontalPadding * 2);
    if (innerWidth === 0) return [truncateToWidth(this.left, width, "…")];

    const left = truncateToWidth(this.left, innerWidth, "…");
    const leftWidth = visibleWidth(left);
    if (!this.right) return left ? [` ${left}`] : [];

    const minimumGap = leftWidth > 0 ? sectionGap : 0;
    const rightBudget = innerWidth - leftWidth - minimumGap;
    let right = this.right;
    if (visibleWidth(right) > rightBudget) {
      if (!this.compactRight || visibleWidth(this.compactRight) > rightBudget) {
        return left ? [` ${left}`] : [];
      }
      right = this.compactRight;
    }

    const gap = Math.max(minimumGap, innerWidth - leftWidth - visibleWidth(right));
    return [` ${left}${" ".repeat(gap)}${right} `];
  }

  invalidate(): void {}
}
