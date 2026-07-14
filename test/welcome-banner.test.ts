import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import {
  BRAND_MARK,
  BRAND_MARK_WIDTH,
  Divider,
  WelcomeBanner,
  WIDE_BANNER_MIN_WIDTH
} from "../packages/zcode-tui/src/welcome-banner.ts";

function banner(width: number, color = false): string[] {
  return new WelcomeBanner(createTheme(color), {
    branch: "main",
    distributionVersion: "3.3.5-2",
    runtimeVersion: "0.15.2",
    workspace: "/Users/alice/Documents/code/ai/zcode-cli"
  }).render(width);
}

describe("welcome banner", () => {
  test("uses a four-line split Z mark inspired by the Desktop icon", () => {
    expect(BRAND_MARK).toHaveLength(4);
    for (const line of BRAND_MARK) {
      expect(visibleWidth(line)).toBe(BRAND_MARK_WIDTH);
      expect(line).toMatch(/^[\u0020\u2580-\u259f]+$/u);
    }
  });

  test("integrates identity, versions and workspace into the wide header", () => {
    const lines = banner(80);
    const output = lines.join("\n");

    expect(lines).toHaveLength(4);
    expect(output).toContain("ZCODE  v3.3.5-2");
    expect(output).toContain("runtime v0.15.2");
    expect(output).toContain("/Users/alice/Documents/code/ai/zcode-cli");
    expect(output).toContain("branch main");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  test("switches to a compact two-line identity below the wide breakpoint", () => {
    const lines = banner(WIDE_BANNER_MIN_WIDTH - 1);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ZCODE  v3.3.5-2");
    expect(lines[1]).toContain("zcode-cli · branch main");
  });

  test("never wraps at tiny or wide terminal widths", () => {
    for (const width of [1, 8, 20, 47, 48, 80, 120]) {
      const lines = banner(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  test("uses theme tokens and strips untrusted terminal controls", () => {
    const view = new WelcomeBanner(createTheme(true, "light"), {
      branch: "main\nsecondary\u001b[2J",
      distributionVersion: "3.3.5-2\u001b]0;bad\u0007",
      runtimeVersion: "0.15.2",
      workspace: "/tmp/project\u001b[H"
    });
    const output = view.render(80).join("\n");

    expect(output).toContain("\x1b[38;5;25m");
    expect(output).not.toContain("\x1b[2J");
    expect(output).not.toContain("\x1b]0;bad");
    expect(output).not.toContain("\x1b[H");
    expect(output).toContain("branch main secondary");
  });
});

describe("Divider component", () => {
  test("renders a single padded line spanning the terminal width", () => {
    const muted = (text: string): string => `\x1b[2m${text}\x1b[0m`;
    const divider = new Divider("─", muted);
    const lines = divider.render(40);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0] ?? "")).toBe(40);
    expect(lines[0]).toContain("─");
  });

  test("renders an empty line for non-positive widths", () => {
    const divider = new Divider("─", (text) => text);
    expect(divider.render(0)).toEqual([""]);
  });
});
