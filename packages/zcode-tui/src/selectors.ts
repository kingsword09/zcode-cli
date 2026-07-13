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

export function isEffortPickerRequest(input: string): boolean {
  return pickerRequest(input, new Set(["effort", "variant"]));
}

export function modelPicker(options: unknown[], currentModel?: string): PickerSpec {
  const items: PickerItem[] = [];
  const seen = new Set<string>();

  for (const option of options) {
    const record = isRecord(option) ? option : undefined;
    const id = asString(record?.id) ?? asString(option);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const details = [
      asString(record?.name) !== id ? asString(record?.name) : undefined,
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
