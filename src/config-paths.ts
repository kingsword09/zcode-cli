import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

export function cliSettingsPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, fallbackHome = homedir()): string {
  const path = platform === "win32" ? win32 : posix;
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim() || fallbackHome;
  return path.join(home, ".zcode", "cli", "setting.json");
}

export function desktopSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(dirname(cliSettingsPath(env))), "v2", "setting.json");
}

export function readDesktopSettings(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(desktopSettingsPath(env), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid settings object");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Unable to read Desktop setting.json; the file was left unchanged.");
  }
}

export function sharedDataBaseDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, fallbackHome = homedir()): string {
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim() || fallbackHome;
  const desktop = platform === process.platform ? readDesktopSettings(env).dataBaseDir : undefined;
  return env.ZCODE_DATA_BASE_DIR?.trim() || (typeof desktop === "string" && desktop.trim()) || home;
}

export function providerConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, fallbackHome = homedir()): string {
  const path = platform === "win32" ? win32 : posix;
  return env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
    || path.join(sharedDataBaseDir(env, platform, fallbackHome), ".zcode", "v2", "provider_config.json");
}

export function legacyCliConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(cliSettingsPath(env)), "config.json");
}

export function settingsMigrationMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(cliSettingsPath(env)), "migrations", "settings-v1.json");
}

export function providerMigrationMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  const target = createHash("sha256").update(providerConfigPath(env)).digest("hex").slice(0, 16);
  return join(dirname(cliSettingsPath(env)), "migrations", `provider-registry-${target}.json`);
}
