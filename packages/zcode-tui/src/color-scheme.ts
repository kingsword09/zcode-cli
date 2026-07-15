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
