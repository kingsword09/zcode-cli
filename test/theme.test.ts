import { describe, expect, test } from "bun:test";

import {
  colorSchemeFromColorFgBg,
  colorSchemeFromRgb,
  initialColorScheme,
  themePreference
} from "../packages/zcode-tui/src/color-scheme.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

function xtermRgb(index: number): [number, number, number] {
  const base: Array<[number, number, number]> = [
    [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
    [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
    [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
    [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]
  ];
  if (index < 16) return base[index] ?? [0, 0, 0];
  if (index < 232) {
    const levels = [0, 95, 135, 175, 215, 255];
    const value = index - 16;
    return [
      levels[Math.floor(value / 36)] ?? 0,
      levels[Math.floor(value / 6) % 6] ?? 0,
      levels[value % 6] ?? 0
    ];
  }
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray];
}

function luminance(color: [number, number, number]): number {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

function sgrContrast(value: string): number {
  const match = /38;5;(\d+);48;5;(\d+)/u.exec(value);
  if (!match) return 0;
  const foreground = luminance(xtermRgb(Number(match[1])));
  const background = luminance(xtermRgb(Number(match[2])));
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
}

describe("TUI terminal theme", () => {
  test("detects light and dark terminal backgrounds", () => {
    expect(colorSchemeFromRgb({ r: 0, g: 0, b: 0 })).toBe("dark");
    expect(colorSchemeFromRgb({ r: 255, g: 255, b: 255 })).toBe("light");
    expect(colorSchemeFromRgb({ r: 18, g: 52, b: 86 })).toBe("dark");
    expect(colorSchemeFromRgb({ r: 238, g: 238, b: 238 })).toBe("light");

    expect(colorSchemeFromColorFgBg("15;0")).toBe("dark");
    expect(colorSchemeFromColorFgBg("0;15")).toBe("light");
    expect(colorSchemeFromColorFgBg("0;8")).toBe("dark");
    expect(colorSchemeFromColorFgBg("0;255")).toBeUndefined();
    expect(colorSchemeFromColorFgBg("invalid")).toBeUndefined();
  });

  test("honors explicit config themes and safely falls back to auto", () => {
    expect(themePreference(" DARK ")).toBe("dark");
    expect(themePreference("light")).toBe("light");
    expect(themePreference("unsupported")).toBe("auto");
    expect(themePreference(undefined)).toBe("auto");
    expect(initialColorScheme("dark", "0;15")).toBe("dark");
    expect(initialColorScheme("light", "15;0")).toBe("light");
    expect(initialColorScheme("auto", "0;15")).toBe("light");
    expect(initialColorScheme("auto", "invalid")).toBe("dark");
  });

  test("pairs every card background with a readable foreground", () => {
    const theme = createTheme(true, "dark");
    const surface = theme.toolErrorBackground;
    const rendered = surface(`plain ${theme.bold("bold")} tail`);

    expect(rendered).toStartWith("\x1b[38;5;252;48;5;52m");
    expect(rendered).toContain("\x1b[0m\x1b[38;5;252;48;5;52m tail");

    theme.setColorScheme("light");
    expect(surface("plain")).toStartWith("\x1b[38;5;236;48;5;224m");
    expect(theme.accent("accent")).toStartWith("\x1b[38;5;25m");
    expect(theme.select.selectedText("selected")).toContain("\x1b[38;5;25m");
  });

  test("keeps emphasized surfaces above WCAG AA contrast", () => {
    const dark = createTheme(true, "dark");
    expect(sgrContrast(dark.diffHunkLine("hunk"))).toBeGreaterThanOrEqual(4.5);
    expect(sgrContrast(dark.toolErrorBackground("error"))).toBeGreaterThanOrEqual(4.5);
    const light = createTheme(true, "light");
    expect(sgrContrast(light.toolPendingBackground("permission"))).toBeGreaterThanOrEqual(4.5);
    expect(sgrContrast(light.toolErrorBackground("error"))).toBeGreaterThanOrEqual(4.5);
  });

  test("gives selected options an explicit foreground in both color schemes", () => {
    const theme = createTheme(true, "dark");
    expect(theme.select.selectedText("selected")).toContain("\x1b[38;5;75m");
    theme.setColorScheme("light");
    expect(theme.select.selectedText("selected")).toContain("\x1b[38;5;25m");
  });

  test("never relies on the terminal default foreground for strong text", () => {
    const theme = createTheme(true, "dark");
    expect(theme.bold("strong")).toStartWith("\x1b[1;38;5;252m");
    theme.setColorScheme("light");
    expect(theme.bold("strong")).toStartWith("\x1b[1;38;5;236m");
    expect(theme.select.selectedText("selected")).toContain("\x1b[38;5;25mselected");
  });

  test("keeps no-color output unchanged", () => {
    const theme = createTheme(false, "light");
    expect(theme.toolErrorBackground("failure")).toBe("failure");
    expect(theme.accent("accent")).toBe("accent");
    expect(theme.searchMatch("match")).toBe("⟦match⟧");
  });
});
