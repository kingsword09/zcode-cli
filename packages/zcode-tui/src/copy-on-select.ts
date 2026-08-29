import { readUserConfig, updateUserConfig } from "../../../src/model-access.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function configuredCopyOnSelect(config: unknown): boolean | undefined {
  const value = record(record(config)?.ui)?.copyOnSelect;
  return typeof value === "boolean" ? value : undefined;
}

export async function readCopyOnSelect(
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const config = await readUserConfig(env);
  return configuredCopyOnSelect(config) ?? true;
}

export async function writeCopyOnSelect(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return await updateUserConfig((config) => {
    const ui = record(config.ui) ?? {};
    ui.copyOnSelect = enabled;
    config.ui = ui;
  }, env);
}
