import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface ProviderConfig {
  models?: Record<string, unknown>;
  options?: {
    apiKey?: unknown;
  };
}

interface UserConfig {
  model?: {
    main?: unknown;
  };
  provider?: Record<string, ProviderConfig>;
}

export interface ConfiguredModelAccess {
  configPath: string;
  model: string;
  providerId: string;
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), ".zcode", "cli", "config.json");
}

export async function readConfiguredModelAccess(
  env: NodeJS.ProcessEnv = process.env
): Promise<ConfiguredModelAccess | null> {
  const configPath = userConfigPath(env);
  let config: UserConfig;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as UserConfig;
  } catch {
    return null;
  }

  const model = typeof config.model?.main === "string" ? config.model.main.trim() : "";
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return null;
  const providerId = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  const provider = config.provider?.[providerId];
  const apiKey = provider?.options?.apiKey;
  if (!provider?.models?.[modelId] || typeof apiKey !== "string" || !apiKey.trim()) return null;
  return { configPath, model, providerId };
}
