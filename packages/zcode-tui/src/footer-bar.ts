import {
  truncateToWidth,
  visibleWidth,
  type Component
} from "@earendil-works/pi-tui";

const horizontalPadding = 1;
const minimumRightWidth = 12;
const sectionGap = 2;

export class FooterBar implements Component {
  private left = "";
  private right?: string;

  setContent(left: string, right?: string): void {
    this.left = left;
    this.right = right || undefined;
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    const innerWidth = Math.max(0, width - horizontalPadding * 2);
    if (innerWidth === 0) return [truncateToWidth(this.left, width, "…")];

    const left = truncateToWidth(this.left, innerWidth, "…");
    const leftWidth = visibleWidth(left);
    if (!this.right) return [` ${left}`];

    const rightBudget = innerWidth - leftWidth - sectionGap;
    if (rightBudget < minimumRightWidth) return [` ${left}`];

    const right = truncateToWidth(this.right, rightBudget, "…");
    const gap = Math.max(sectionGap, innerWidth - leftWidth - visibleWidth(right));
    return [` ${left}${" ".repeat(gap)}${right} `];
  }

  invalidate(): void {}
}
