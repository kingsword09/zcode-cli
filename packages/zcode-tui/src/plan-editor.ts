import { Editor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Decorate the existing border without changing editor rows or cursor coordinates. */
export class PlanEditor extends Editor {
  planEnabled = false;
  planColor: (text: string) => string = text => text;
  planHint = "Research and plan before making changes";
  hintColor: (text: string) => string = text => text;

  override render(width: number): string[] {
    const lines = super.render(width);
    if (!this.planEnabled || width < 4 || !lines[0]) return lines;
    const label = width >= 10 ? " Plan ──" : "Plan";
    const prefixWidth = width - visibleWidth(label);
    // Keep the editor's left-hand scroll indicator when it fits.
    const prefix = truncateToWidth(lines[0], prefixWidth, "");
    lines[0] = prefix + this.borderColor("─".repeat(Math.max(0, prefixWidth - visibleWidth(prefix)))) + this.planColor(label);
    if (!this.getText() && lines[1] && width > 2) {
      const cursor = truncateToWidth(lines[1], 2, "");
      const hint = truncateToWidth(this.planHint, width - 2, "");
      lines[1] = cursor + this.hintColor(hint) + " ".repeat(Math.max(0, width - 2 - visibleWidth(hint)));
    }
    return lines;
  }
}
