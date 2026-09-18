import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";

import defaultCliSettings from "../setting.example.json" with { type: "json" };
import { cliSettingsPath, legacyCliConfigPath, providerConfigPath, settingsMigrationMarkerPath, sharedDataBaseDir } from "./config-paths.ts";
export { cliSettingsPath, providerConfigPath } from "./config-paths.ts";

export interface ConfiguredModelAccess {
  configPath: string;
  model: string;
  providerId: string;
}

export interface CliSettingsBootstrapResult {
  configPath: string;
  created: boolean;
  migrated?: boolean;
}

export type CliSettingsRecord = Record<string, unknown>;

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

export function providerConfigPathHint(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? "%USERPROFILE%\\.zcode\\v2\\provider_config.json"
    : "~/.zcode/v2/provider_config.json";
}

async function finishSettingsMigration(env: NodeJS.ProcessEnv): Promise<void> {
  const marker = settingsMigrationMarkerPath(env);
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
  let file;
  try {
    file = await open(marker, "wx", 0o600);
    await file.writeFile('{"schemaVersion":1}\n', "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  } finally {
    await file?.close();
  }
}

export async function ensureCliSettings(
  env: NodeJS.ProcessEnv = process.env
): Promise<CliSettingsBootstrapResult> {
  const configPath = cliSettingsPath(env);
  const configDirectory = dirname(configPath);
  try {
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Unable to create ZCode config directory ${configDirectory}: ${errorMessage(error)}`, {
      cause: error
    });
  }

  if (await configFileExists(configPath)) {
    await finishSettingsMigration(env);
    return { configPath, created: false };
  }

  let initial: Record<string, unknown> = defaultCliSettings;
  let migrated = false;
  try {
    if (await configFileExists(settingsMigrationMarkerPath(env))) {
      // A deliberate reset of the new file must not resurrect old settings.
      initial = defaultCliSettings;
    } else {
      const legacy = JSON.parse(await readFile(legacyCliConfigPath(env), "utf8"));
      if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw new Error("invalid legacy settings");
      const { provider, model, modelCatalog, ...settings } = legacy;
      initial = settings;
      migrated = true;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new Error("Unable to migrate the old CLI config.json; the original file was preserved.");
    }
  }

  const temporaryPath = join(
    configDirectory,
    `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let file;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(initial, null, 2)}\n`, "utf8");
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
    await finishSettingsMigration(env);
    return { configPath, created: true, ...migrated ? { migrated: true } : {} };
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      if (!await configFileExists(configPath)) {
        throw new Error(`ZCode config path exists but is not a file: ${configPath}`);
      }
      await finishSettingsMigration(env);
      return { configPath, created: false };
    }
    throw new Error(`Unable to create ZCode config file ${configPath}: ${errorMessage(error)}`, {
      cause: error
    });
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function readCliSettings(
  env: NodeJS.ProcessEnv = process.env
): Promise<CliSettingsRecord> {
  const { configPath } = await ensureCliSettings(env);
  try {
    const value: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("the root value must be a JSON object");
    }
    return value as CliSettingsRecord;
  } catch (error) {
    throw new Error(`Unable to read ZCode config ${configPath}: ${errorMessage(error)}`, {
      cause: error
    });
  }
}

export async function updateCliSettings(
  update: (config: CliSettingsRecord) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const configPath = cliSettingsPath(env);
  const config = await readCliSettings(env);
  const before = JSON.stringify(config);
  update(config);
  if (JSON.stringify(config) === before) return configPath;

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


function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Configuration presence only; the runtime owns credential decryption and authentication. */
export async function readConfiguredModelAccess(env: NodeJS.ProcessEnv = process.env): Promise<ConfiguredModelAccess | null> {
  const home = sharedDataBaseDir(env);
  const directory = join(home, ".zcode", "v2");
  const configPath = providerConfigPath(env);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    return null;
  }
  const root = record(value), config = record(root?.config);
  if (root?.schemaVersion !== 1 || !config) return null;
  const selection = record(config.defaultModelSelection);
  const providerId = typeof selection?.providerId === "string" ? selection.providerId.trim() : "";
  const modelId = typeof selection?.modelId === "string" ? selection.modelId.trim() : "";
  if (!providerId || !modelId) return null;
  const result = { configPath, model: `${providerId}/${modelId}`, providerId };
  if (providerId.startsWith("account:")) {
    try {
      const credentials = record(JSON.parse(await readFile(join(directory, "credentials.json"), "utf8")));
      const identity = credentials?.[`account-provider:${providerId}:identity`];
      const keyPrefix = `account-provider:coding-plan:${providerId}:account:`;
      return typeof identity === "string" && identity.length > 0 && Object.entries(credentials ?? {}).some(
        ([key, secret]) => key.startsWith(keyPrefix) && key.endsWith(":api-key")
          && typeof secret === "string" && secret.length > 0
      ) ? result : null;
    } catch {
      return null;
    }
  }
  const rules = record(config.providerConfigRules)?.providerRules;
  if (!Array.isArray(rules)) return null;
  const provider = rules.map(record).find((rule) => rule?.providerId === providerId);
  const settings = record(provider?.config), access = record(settings?.access);
  return settings?.visibility !== "hidden" && typeof access?.apiKey === "string" && access.apiKey.trim()
    && (!Array.isArray(settings?.personalModelIds) || settings.personalModelIds.includes(modelId)) ? result : null;
}

/** A native personal provider can be usable without a saved default selection. */
export async function hasConfiguredProviderAccess(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (await readConfiguredModelAccess(env)) return true;
  try {
    const value = record(JSON.parse(await readFile(providerConfigPath(env), "utf8")));
    const rules = record(record(value?.config)?.providerConfigRules)?.providerRules;
    return value?.schemaVersion === 1 && Array.isArray(rules) && rules.some(raw => {
      const rule = record(raw), config = record(rule?.config), access = record(config?.access);
      return rule?.enabled !== false && config?.visibility !== "hidden"
        && typeof access?.apiKey === "string" && access.apiKey.trim().length > 0
        && (typeof rule?.templateId === "string" || Array.isArray(config?.personalModelIds) && config.personalModelIds.length > 0);
    });
  } catch {
    return false;
  }
}

export function setupPendingPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir()
): string {
  const path = platform === "win32" ? win32 : posix;
  const configuredHome = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim();
  return path.join(configuredHome || fallbackHome, ".zcode", "cli", "setup-pending");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readSetupPending(
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  return await pathExists(setupPendingPath(env));
}

export async function markSetupPending(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const pendingPath = setupPendingPath(env);
  await mkdir(dirname(pendingPath), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(pendingPath),
    `.${basename(pendingPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let file;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${new Date().toISOString()}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, pendingPath);
  } finally {
    await file?.close();
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function clearSetupPending(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await rm(setupPendingPath(env), { force: true }).catch(() => {});
}
