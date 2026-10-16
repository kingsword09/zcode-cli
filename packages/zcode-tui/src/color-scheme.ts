import type { TUI } from "@earendil-works/pi-tui";

export type ZCodeColorScheme = "dark" | "light";
export type ZCodeThemePreference = ZCodeColorScheme | "auto";

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Resolve the terminal palette from its reported background color. */
export function colorSchemeFromRgb(color: RgbColor): ZCodeColorScheme {
  const luminance = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
  return luminance > 0.5 ? "light" : "dark";
}

/** Query pi-tui's combined palette, retaining the terminal scheme-report fallback. */
export async function queryTerminalColorScheme(
  ui: Pick<TUI, "onTerminalColorSchemeChange" | "queryTerminalColors"> & {
    terminal: Pick<TUI["terminal"], "write">;
  },
  timeoutMs: number
): Promise<ZCodeColorScheme | undefined> {
  let reportedScheme: ZCodeColorScheme | undefined;
  const unsubscribe = ui.onTerminalColorSchemeChange((scheme) => {
    reportedScheme = scheme;
  });
  try {
    // Ask before the palette query's DA1 sentinel so a scheme-only terminal
    // can answer before queryTerminalColors completes.
    ui.terminal.write("\x1b[?996n");
    const colors = await ui.queryTerminalColors({ timeoutMs });
    return colors.background ? colorSchemeFromRgb(colors.background) : reportedScheme;
  } finally {
    unsubscribe();
  }
}

/**
 * Best-effort synchronous fallback for terminals that expose COLORFGBG.
 * The last ANSI color is the background; values outside the conventional
 * 16-color range are ignored because their actual RGB values are terminal-defined.
 */
export function colorSchemeFromColorFgBg(value = process.env.COLORFGBG): ZCodeColorScheme | undefined {
  if (!value) return undefined;
  const background = Number(value.split(";").at(-1));
  if (!Number.isInteger(background) || background < 0 || background > 15) return undefined;
  return background <= 6 || background === 8 ? "dark" : "light";
}

/** Normalize config input without letting an invalid value disable detection. */
export function themePreference(value: unknown): ZCodeThemePreference {
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase();
  return normalized === "dark" || normalized === "light" ? normalized : "auto";
}

export function initialColorScheme(
  preference: ZCodeThemePreference,
  colorFgBg = process.env.COLORFGBG
): ZCodeColorScheme {
  return preference === "auto"
    ? colorSchemeFromColorFgBg(colorFgBg) ?? "dark"
    : preference;
}
