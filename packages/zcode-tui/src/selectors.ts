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

/** Provider→model cascade produced from the runtime's modelOptions list. */
export interface ProviderModelGroup {
  providerId: string;
  label: string;
  models: PickerSpec;
}

export interface ProviderModelPicker {
  providers: PickerSpec;
  groups: ProviderModelGroup[];
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
  if (/^(?:main|lite|sonnet|opus|haiku)$/iu.test(argument)) return argument;
  const separator = argument.indexOf("/");
  if (separator <= 0 || separator === argument.length - 1) return undefined;
  return argument;
}

export function isEffortPickerRequest(input: string): boolean {
  return pickerRequest(input, new Set(["effort", "variant"]));
}

interface ModelOption {
  id: string;
  providerId: string;
  modelId: string;
  name?: string;
  providerLabel?: string;
}

function extractModelId(record: Record<string, unknown> | undefined, raw: unknown): string | undefined {
  const direct = asString(record?.id);
  if (direct) return direct;
  const modelId = asString(record?.modelId);
  if (modelId) {
    const providerId = asString(record?.providerId);
    return providerId ? `${providerId}/${modelId}` : modelId;
  }
  return asString(raw);
}

function parseModelRef(id: string): { providerId: string; modelId: string } | undefined {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  return { providerId: id.slice(0, separator), modelId: id.slice(separator + 1) };
}

function extractModelOption(option: unknown): ModelOption | undefined {
  const record = isRecord(option) ? option : undefined;
  const id = extractModelId(record, option);
  if (!id) return undefined;
  const parsed = parseModelRef(id);
  if (!parsed) return undefined;
  return {
    id,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    name: asString(record?.name) ?? asString(record?.label),
    providerLabel: asString(record?.providerLabel) ?? asString(record?.providerName)
  };
}

function modelLabel(option: ModelOption): string {
  return option.name && option.name !== option.modelId
    ? option.name
    : option.modelId;
}

function describeModel(option: ModelOption, currentModel?: string): string | undefined {
  const details = [
    option.name && option.name !== option.modelId ? option.name : undefined,
    option.id === currentModel ? "current" : undefined
  ].filter((value): value is string => Boolean(value));
  return details.length > 0 ? details.join(" · ") : undefined;
}

function providerLabel(option: ModelOption): string {
  return option.providerLabel ?? option.providerId;
}

/**
 * Group the runtime's flat `modelOptions` list by provider, producing a
 * three-level cascade: provider → main model → lite model.
 *
 * The runtime passes each option as `{ modelId, providerId, ... }` (from
 * `listModels()`/`RXr`), but tests and some callers use `{ id, name }` — both
 * forms are accepted.
 */
export function providerModelPicker(options: unknown[], currentModel?: string): ProviderModelPicker | null {
  const byProvider = new Map<string, ModelOption[]>();
  const seen = new Set<string>();

  for (const option of options) {
    const parsed = extractModelOption(option);
    if (!parsed) continue;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    const group = byProvider.get(parsed.providerId) ?? [];
    group.push(parsed);
    byProvider.set(parsed.providerId, group);
  }

  if (byProvider.size === 0) return null;

  const groups: ProviderModelGroup[] = [];
  for (const [providerId, models] of byProvider) {
    const label = providerLabel(models[0]!);
    const items: PickerItem[] = models.map((model) => ({
      value: model.id,
      label: modelLabel(model),
      description: describeModel(model, currentModel),
      command: `/model ${model.id}`
    }));
    const currentIndex = items.findIndex((item) => item.value === currentModel);
    groups.push({
      providerId,
      label,
      models: { items, selectedIndex: currentIndex >= 0 ? currentIndex : 0 }
    });
  }

  const providerItems: PickerItem[] = groups.map((group) => {
    const currentInGroup = group.models.items.some((item) => item.value === currentModel);
    const currentModelId = group.models.items.find((item) => item.value === currentModel)?.label;
    return {
      value: group.providerId,
      label: group.label,
      description: [
        `${group.models.items.length} model${group.models.items.length === 1 ? "" : "s"}`,
        currentInGroup && currentModelId ? `current: ${currentModelId}` : undefined
      ].filter((value): value is string => Boolean(value)).join(" · "),
      command: ""
    };
  });

  return {
    providers: {
      items: providerItems,
      selectedIndex: providerItems.findIndex((item) =>
        groups[providerItems.indexOf(item)]!.models.items.some((m) => m.value === currentModel)
      )
    },
    groups
  };
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
