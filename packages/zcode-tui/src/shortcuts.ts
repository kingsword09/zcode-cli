import type { PickerSpec } from "./selectors.ts";

export const modes = ["build", "edit", "yolo", "plan"] as const;
export type Mode = (typeof modes)[number];
export type SettingTarget = "mode" | "model" | "effort";

export function normalizedMode(mode?: string, fallback: Mode = "build"): Mode {
  const candidate = mode as Mode;
  return modes.includes(candidate) ? candidate : fallback;
}

export function nextMode(currentMode?: string): Mode {
  const currentIndex = modes.indexOf(normalizedMode(currentMode));
  return modes[(currentIndex + 1) % modes.length] ?? modes[0];
}

export function settingTargetForCommand(input: string): SettingTarget | undefined {
  const command = /^\/([^\s]+)/u.exec(input.trim())?.[1]?.toLowerCase();
  if (command === "mode") return "mode";
  if (command === "model") return "model";
  if (command === "effort" || command === "variant") return "effort";
  return undefined;
}

export function appliesToSetting(target: SettingTarget | undefined, field: SettingTarget): boolean {
  return target === undefined || target === field;
}

export function nextPickerCommand(picker: PickerSpec, currentValue?: string): string | undefined {
  if (picker.items.length < 2) return undefined;
  const currentIndex = picker.items.findIndex((item) => item.value === currentValue);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % picker.items.length;
  return picker.items[nextIndex]?.command;
}
