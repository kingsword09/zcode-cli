import { readCliSettings, updateCliSettings } from "../../../src/model-access.ts";

export type ToolCallStyle = "regular" | "compact";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function resolveToolCallStyle(config: unknown): ToolCallStyle {
  const value = record(record(config)?.ui)?.toolCallStyle;
  return value === "compact" ? "compact" : "regular";
}

export async function readToolCallStyle(
  env: NodeJS.ProcessEnv = process.env
): Promise<ToolCallStyle> {
  return resolveToolCallStyle(await readCliSettings(env));
}

export async function writeToolCallStyle(
  style: ToolCallStyle,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return await updateCliSettings((config) => {
    const ui = record(config.ui) ?? {};
    ui.toolCallStyle = style;
    config.ui = ui;
  }, env);
}
