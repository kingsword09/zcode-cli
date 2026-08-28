import { readUserConfig, updateUserConfig } from "../../../src/model-access.ts";

export type TuiMode = "regular" | "fullscreen";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function configuredTuiMode(config: unknown): string | undefined {
  const value = record(record(config)?.ui)?.tuiMode;
  return typeof value === "string" ? value : undefined;
}

function tuiMode(value: unknown): TuiMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "regular" || normalized === "fullscreen"
    ? normalized
    : undefined;
}

export function resolveTuiMode(
  env: NodeJS.ProcessEnv = process.env,
  config?: unknown
): TuiMode {
  return tuiMode(env.ZCODE_TUI_MODE)
    ?? tuiMode(configuredTuiMode(config))
    ?? "regular";
}

export async function readTuiMode(
  env: NodeJS.ProcessEnv = process.env
): Promise<TuiMode> {
  return resolveTuiMode(env, await readUserConfig(env));
}

export async function writeTuiMode(
  mode: TuiMode,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return await updateUserConfig((config) => {
    const ui = record(config.ui) ?? {};
    ui.tuiMode = mode;
    config.ui = ui;
  }, env);
}
