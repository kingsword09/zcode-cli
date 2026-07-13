import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { FooterBar } from "../packages/zcode-tui/src/footer-bar.ts";

describe("TUI footer bar", () => {
  test("keeps turn timing on the left and goal status right-aligned", () => {
    const footer = new FooterBar();
    footer.setContent("thinking… · [12s]", "Pursuing goal (40K / 50K)");

    const [line] = footer.render(60);
    expect(line).toContain("thinking… · [12s]");
    expect(line).toContain("Pursuing goal (40K / 50K)");
    expect(visibleWidth(line ?? "")).toBe(60);
  });

  test("drops supplementary goal text before the turn timer on narrow terminals", () => {
    const footer = new FooterBar();
    footer.setContent("working… · [3s]", "Pursuing goal (40K / 50K)");

    const lines = footer.render(24);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("working… · [3s]");
    expect(lines[0]).not.toContain("Pursuing goal");
    expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(24);
  });
});
