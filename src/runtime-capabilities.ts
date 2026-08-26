export type RuntimeCliOptionType = "boolean" | "string";

export interface RuntimeCliOptionCapability {
  type: RuntimeCliOptionType;
  multiple?: boolean;
}

export interface RuntimeCapabilities {
  schemaVersion: 1;
  cli: {
    globalOptions: Record<string, RuntimeCliOptionCapability>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRuntimeCapabilities(value: unknown): RuntimeCapabilities | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.cli)) return undefined;
  const rawOptions = value.cli.globalOptions;
  if (!isRecord(rawOptions)) return undefined;

  const globalOptions: Record<string, RuntimeCliOptionCapability> = {};
  for (const [name, rawOption] of Object.entries(rawOptions)) {
    if (!name || name.startsWith("-") || !isRecord(rawOption)) return undefined;
    if (rawOption.type !== "boolean" && rawOption.type !== "string") return undefined;
    if (rawOption.multiple !== undefined && typeof rawOption.multiple !== "boolean") return undefined;
    globalOptions[name] = {
      type: rawOption.type,
      ...(rawOption.multiple === true ? { multiple: true } : {})
    };
  }
  return { schemaVersion: 1, cli: { globalOptions } };
}

export function capabilitiesFromExtractionMetadata(value: unknown): RuntimeCapabilities | undefined {
  return isRecord(value) ? parseRuntimeCapabilities(value.runtimeCapabilities) : undefined;
}
