import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";

import defaultUserConfig from "../config.example.json" with { type: "json" };

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

export interface UserConfigBootstrapResult {
  configPath: string;
  created: boolean;
}

export type UserConfigRecord = Record<string, unknown>;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function configFileExists(configPath: string): Promise<boolean> {
  try {
    const existing = await stat(configPath);
    if (!existing.isFile()) throw new Error(`ZCode config path exists but is not a file: ${configPath}`);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export function userConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir()
): string {
  const path = platform === "win32" ? win32 : posix;
  const configuredHome = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim();
  return path.join(configuredHome || fallbackHome, ".zcode", "cli", "config.json");
}

export async function ensureUserConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<UserConfigBootstrapResult> {
  const configPath = userConfigPath(env);
  const configDirectory = dirname(configPath);
  try {
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Unable to create ZCode config directory ${configDirectory}: ${errorMessage(error)}`, {
      cause: error
    });
  }

  if (await configFileExists(configPath)) return { configPath, created: false };

  const temporaryPath = join(
    configDirectory,
    `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let file;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(defaultUserConfig, null, 2)}\n`, "utf8");
    await file.sync();
  } catch (error) {
    if (file) {
      await file.close().catch(() => {});
      file = undefined;
    }
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new Error(`Unable to initialize ZCode config file ${configPath}: ${errorMessage(error)}`, {
      cause: error
    });
  } finally {
    await file?.close();
  }

  try {
    await link(temporaryPath, configPath);
    return { configPath, created: true };
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      if (!await configFileExists(configPath)) {
        throw new Error(`ZCode config path exists but is not a file: ${configPath}`);
      }
      return { configPath, created: false };
    }
    throw new Error(`Unable to create ZCode config file ${configPath}: ${errorMessage(error)}`, {
      cause: error
    });
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function readUserConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<UserConfigRecord> {
  const { configPath } = await ensureUserConfig(env);
  try {
    const value: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("the root value must be a JSON object");
    }
    return value as UserConfigRecord;
  } catch (error) {
    throw new Error(`Unable to read ZCode config ${configPath}: ${errorMessage(error)}`, {
      cause: error
    });
  }
}

export async function updateUserConfig(
  update: (config: UserConfigRecord) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const configPath = userConfigPath(env);
  const config = await readUserConfig(env);
  update(config);

  const temporaryPath = join(
    dirname(configPath),
    `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let file;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, configPath);
    return configPath;
  } catch (error) {
    throw new Error(`Unable to update ZCode config ${configPath}: ${errorMessage(error)}`, {
      cause: error
    });
  } finally {
    await file?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
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
