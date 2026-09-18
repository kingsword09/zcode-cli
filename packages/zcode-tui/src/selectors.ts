import { asString, isRecord } from "./types.ts";

export interface PickerItem {
  value: string;
  label: string;
  description?: string;
  command: string;
}

export interface PickerSpec {
  items: PickerItem[];
  selectedIndex: number;
}

function pickerRequest(input: string, commands: Set<string>): boolean {
  const match = /^\/([^\s]+)(?:\s+(.*))?$/u.exec(input.trim());
  if (!match || !commands.has(match[1]?.toLowerCase() ?? "")) return false;
  const argument = match[2]?.trim().toLowerCase() ?? "";
  return argument === "" || argument === "list";
}

export function isModelPickerRequest(input: string): boolean {
  return pickerRequest(input, new Set(["model"]));
}

export function isModePickerRequest(input: string): boolean {
  return pickerRequest(input, new Set(["mode"]));
}

export function modePicker(currentMode?: string, availableModes?: readonly string[]): PickerSpec {
  const list = (availableModes?.length ? availableModes : ["build", "edit", "yolo"])
    .filter(mode => ["build", "edit", "yolo"].includes(mode));
  const items: PickerItem[] = list.map((mode) => ({
    value: mode,
    label: mode.charAt(0).toUpperCase() + mode.slice(1),
    description: [mode === "build" ? "Ask before changes" : mode === "edit" ? "Edit automatically" : "Full access",
      mode === currentMode ? "current" : undefined].filter(Boolean).join(" · "),
    command: `/mode ${mode}`
  }));
  const currentIndex = items.findIndex((item) => item.value === currentMode);
  return { items, selectedIndex: currentIndex >= 0 ? currentIndex : 0 };
}

/**
 * Extract the explicit model reference from `/model <provider/model>`.
 * Returns undefined for the bare picker forms (`/model`, `/model list`) and
 * malformed references. Runtime aliases are returned as explicit requests so
 * they also use the session-only transient model bridge.
 */
export function explicitModelRequest(input: string): string | undefined {
  const match = /^\/model\s+(\S+)$/iu.exec(input.trim());
  const argument = match?.[1];
  if (!argument || argument.toLowerCase() === "list") return undefined;
  if (argument.toLowerCase() === "main") return "main";
  const separator = argument.indexOf("/");
  if (separator <= 0 || separator === argument.length - 1) return undefined;
  return argument;
}

export function isEffortPickerRequest(input: string): boolean {
  return pickerRequest(input, new Set(["effort", "variant"]));
}

function extractModelId(record: Record<string, unknown> | undefined, raw: unknown): string | undefined {
  const direct = asString(record?.id);
  if (direct) return direct;
  const ref = isRecord(record?.ref) ? record.ref : record;
  const modelId = asString(ref?.modelId);
  if (modelId) {
    const providerId = asString(ref?.providerId);
    return providerId ? `${providerId}/${modelId}` : modelId;
  }
  return asString(raw);
}

export function modelPicker(options: unknown[], currentModel?: string): PickerSpec {
  const items: PickerItem[] = [];
  const seen = new Set<string>();

  for (const option of options) {
    const record = isRecord(option) ? option : undefined;
    const id = extractModelId(record, option);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const name = asString(record?.name) ?? asString(record?.label);
    const details = [
      name !== id ? name : undefined,
      asString(record?.alias),
      id === currentModel ? "current" : undefined
    ].filter((value): value is string => Boolean(value));
    items.push({
      value: id,
      label: id,
      description: details.length > 0 ? details.join(" · ") : undefined,
      command: `/model ${id}`
    });
  }

  const currentIndex = items.findIndex((item) => item.value === currentModel);
  return { items, selectedIndex: currentIndex >= 0 ? currentIndex : 0 };
}

export function effortPicker(options: unknown[], currentEffort?: string): PickerSpec {
  const items: PickerItem[] = [];
  const seen = new Set<string>();

  for (const option of options) {
    const record = isRecord(option) ? option : undefined;
    const id = asString(record?.id) ?? asString(option);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const label = asString(record?.label) ?? id;
    items.push({
      value: id,
      label,
      description: [label !== id ? id : undefined, id === currentEffort ? "current" : undefined]
        .filter((value): value is string => Boolean(value))
        .join(" · ") || undefined,
      command: `/effort ${id}`
    });
  }

  const currentIndex = items.findIndex((item) => item.value === currentEffort);
  return { items, selectedIndex: currentIndex >= 0 ? currentIndex : 0 };
}
