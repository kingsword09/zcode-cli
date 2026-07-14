import { describe, expect, test } from "bun:test";

import {
  colorSchemeFromColorFgBg,
  colorSchemeFromRgb
} from "../packages/zcode-tui/src/color-scheme.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

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

  test("pairs every card background with a readable foreground", () => {
    const theme = createTheme(true, "dark");
    const surface = theme.toolSuccessBackground;
    const rendered = surface(`plain ${theme.bold("bold")} tail`);

    expect(rendered).toStartWith("\x1b[38;5;252;48;5;234m");
    expect(rendered).toContain("\x1b[0m\x1b[38;5;252;48;5;234m tail");

    theme.setColorScheme("light");
    expect(surface("plain")).toStartWith("\x1b[38;5;236;48;5;254m");
    expect(theme.accent("accent")).toStartWith("\x1b[38;5;25m");
  });

  test("keeps no-color output unchanged", () => {
    const theme = createTheme(false, "light");
    expect(theme.toolErrorBackground("failure")).toBe("failure");
    expect(theme.accent("accent")).toBe("accent");
  });
});
