import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

import type { PickerSpec } from "./selectors.ts";

export const modes = ["build", "edit", "yolo", "plan"] as const;
export type Mode = (typeof modes)[number];

// Client-side modes: adds "auto", a classifier overlay on top of the runtime's
// build mode. The runtime owns its enum and has no auto mode (its reserved
// value denies everything), so "auto" is client-side only: entering it forces
// the runtime to build (prompts still reach the client) while the TUI shows
// auto and decides prompts through the permission classifier.
export const clientModes = ["build", "edit", "auto", "yolo", "plan"] as const;
export type ClientMode = (typeof clientModes)[number];
export type SettingTarget = "mode" | "model" | "effort";

export function normalizedClientMode(mode?: string, fallback: ClientMode = "build"): ClientMode {
  const candidate = mode as ClientMode;
  return clientModes.includes(candidate) ? candidate : fallback;
}

export function normalizedMode(mode?: string, fallback: Mode = "build"): Mode {
  const candidate = mode as Mode;
  return modes.includes(candidate) ? candidate : fallback;
}

// Client-side acceptance of a runtime-confirmed mode result (typed /mode
// answers, runtime state echoes, setMode confirmations). The runtime owns its
// enum and reserves `auto`, so confirmed values must normalize through the
// runtime-only validator above: letting the reserved value pass
// normalizedClientMode would leave the client mode at "auto" with the overlay
// exited, and the classifier gate reads the mode alone.
export function runtimeResultClientMode(resultMode: string | undefined, currentMode: ClientMode): ClientMode {
  return normalizedMode(resultMode, normalizedMode(currentMode));
}

export function nextMode(currentMode?: string): Mode {
  const currentIndex = modes.indexOf(normalizedMode(currentMode));
  return modes[(currentIndex + 1) % modes.length] ?? modes[0];
}

// Shift+Tab cycles the client-side list (which includes the auto overlay);
// runtime mode state is always representable because auto rides on build.
export function nextClientMode(currentMode?: string): ClientMode {
  const currentIndex = clientModes.indexOf(normalizedClientMode(currentMode));
  return clientModes[(currentIndex + 1) % clientModes.length] ?? clientModes[0];
}

// Boot-time selection for one-shot/headless runs: ZCODE_CLIENT_MODE=auto
// activates the overlay only when the runtime booted in build (its prompt
// modes are the only ones where client-side classification is meaningful).
export function initialClientMode(runtimeMode: string | undefined, envClientMode: string | undefined): ClientMode {
  if (envClientMode === "auto") {
    // Reject a runtime genuinely in its reserved `auto` before normalizing:
    // normalization would silently re-label it "build" and switch the overlay
    // on over a deny-everything runtime.
    if (runtimeMode === "auto") return normalizedMode(runtimeMode)
    return normalizedMode(runtimeMode) === "build" ? "auto" : normalizedMode(runtimeMode)
  }
  return normalizedMode(runtimeMode)
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

/** Like nextPickerCommand but returns the item value (model id) directly. */
export function nextPickerValue(picker: PickerSpec, currentValue?: string): string | undefined {
  if (picker.items.length < 2) return undefined;
  const currentIndex = picker.items.findIndex((item) => item.value === currentValue);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % picker.items.length;
  return picker.items[nextIndex]?.value;
}

export function transcriptPageDirection(data: string): -1 | 1 | undefined {
  if (isKeyRelease(data)) return undefined;
  if (matchesKey(data, "pageUp") || matchesKey(data, "left")) return -1;
  if (matchesKey(data, "pageDown") || matchesKey(data, "right")) return 1;
  return undefined;
}
