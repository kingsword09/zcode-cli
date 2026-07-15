import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { FooterBar } from "../packages/zcode-tui/src/footer-bar.ts";

describe("TUI footer bar", () => {
  test("keeps turn timing on the left and goal status right-aligned", () => {
    const footer = new FooterBar();
    footer.setContent(
      "thinking… ── [ 🕛 12s ]",
      "[ Goal: Active (40K / 50K) ]",
      "[ Goal: Active ]"
    );

    const [line] = footer.render(60);
    expect(line).toContain("thinking… ── [ 🕛 12s ]");
    expect(line).toContain("[ Goal: Active (40K / 50K) ]");
    expect(visibleWidth(line ?? "")).toBe(60);
  });

  test("drops supplementary goal text before the turn timer on narrow terminals", () => {
    const footer = new FooterBar();
    footer.setContent(
      "working… ── [ 🕛 3s ]",
      "[ Goal: Active (40K / 50K) ]",
      "[ Goal: Active ]"
    );

    const lines = footer.render(24);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("working… ── [ 🕛 3s ]");
    expect(lines[0]).not.toContain("Goal:");
    expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(24);
  });

  test("uses a complete compact goal instead of truncating its label", () => {
    const footer = new FooterBar();
    footer.setContent(
      "[ 🕛 0s ]",
      "[ Goal: Active (40K / 50K) ]",
      "[ Goal: Active ]"
    );

    expect(footer.render(36)[0]).toContain("[ Goal: Active ]");
    expect(footer.render(36)[0]).not.toContain("40K");
    expect(footer.render(24)[0]).not.toContain("Goal:");
  });

  test("does not reserve an idle row without timing or goal content", () => {
    const footer = new FooterBar();
    footer.setContent("");
    expect(footer.render(80)).toEqual([]);
  });
});
