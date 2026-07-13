import type { PickerSpec } from "./selectors.ts";

export const autonomyModes = ["build", "edit", "yolo"] as const;

export function executionMode(mode?: string, fallback = "build"): string {
  const candidate = mode as (typeof autonomyModes)[number];
  return autonomyModes.includes(candidate) ? candidate : fallback;
}

export function toggledWorkMode(currentMode: string, lastExecutionMode: string): string {
  return currentMode === "plan" ? executionMode(lastExecutionMode) : "plan";
}

export function nextAutonomyMode(currentMode: string, lastExecutionMode: string): string {
  if (currentMode === "plan") return executionMode(lastExecutionMode);
  const currentIndex = autonomyModes.indexOf(currentMode as (typeof autonomyModes)[number]);
  return autonomyModes[(currentIndex + 1) % autonomyModes.length] ?? autonomyModes[0];
}

export function nextPickerCommand(picker: PickerSpec, currentValue?: string): string | undefined {
  if (picker.items.length < 2) return undefined;
  const currentIndex = picker.items.findIndex((item) => item.value === currentValue);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % picker.items.length;
  return picker.items[nextIndex]?.command;
}
