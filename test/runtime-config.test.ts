import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cliSettingsPath, desktopSettingsPath, legacyCliConfigPath, providerConfigPath } from "../src/config-paths.ts";
import { ensureCliSettings, readCliSettings } from "../src/model-access.ts";
import { mergeDesktopSettings } from "../src/runtime-config-bridge.ts";
import { writeNotificationSettings } from "../packages/zcode-tui/src/notifications.ts";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "zcode-settings-"));
  homes.push(home);
  const env = { HOME: home, USERPROFILE: home };
  await mkdir(dirname(desktopSettingsPath(env)), { recursive: true });
  return { home, env };
}

test("reuses native Desktop preferences without copying them into CLI settings", async () => {
  const { env } = await fixture();
  const desktop = JSON.stringify({ localePreference: "zh-CN", memoryEnabled: false, terminalFontFamily: "desktop-only" });
  await writeFile(desktopSettingsPath(env), desktop);
  await ensureCliSettings(env);
  const input = await readCliSettings(env);
  expect(input.ui).not.toHaveProperty("locale");
  expect(mergeDesktopSettings(input, cliSettingsPath(env), env)).toMatchObject({
    ui: { locale: "zh-CN" }, memory: { use: false, write: false }, features: { memory: false }
  });
  expect(mergeDesktopSettings({ ui: { locale: "en-US" }, memory: { use: true } }, cliSettingsPath(env), env))
    .toMatchObject({ ui: { locale: "en-US" }, memory: { use: true, write: false }, features: { memory: true } });
  expect(mergeDesktopSettings({ memory: { use: true }, features: { memory: false } }, cliSettingsPath(env), env))
    .toMatchObject({ memory: { use: true, write: false }, features: { memory: false } });
  const project = { ui: { theme: "dark" } };
  expect(mergeDesktopSettings(project, "/workspace/zcode.json", env)).toBe(project);
  await writeNotificationSettings({ method: "off", condition: "always" }, env);
  expect(await readFile(desktopSettingsPath(env), "utf8")).toBe(desktop);
  expect((await readCliSettings(env)).ui).not.toHaveProperty("locale");
});

test("migrates CLI settings once and never reads the old file as a fallback", async () => {
  const { env } = await fixture();
  await mkdir(dirname(legacyCliConfigPath(env)), { recursive: true });
  const legacy = { provider: { custom: {} }, model: { main: "custom/test" }, modelCatalog: {}, ui: { theme: "dark" } };
  await writeFile(legacyCliConfigPath(env), JSON.stringify(legacy));
  expect(await ensureCliSettings(env)).toMatchObject({ created: true, migrated: true });
  expect(await readCliSettings(env)).toEqual({ ui: { theme: "dark" } });
  await writeFile(legacyCliConfigPath(env), JSON.stringify({ ui: { theme: "light" } }));
  expect(await readCliSettings(env)).toEqual({ ui: { theme: "dark" } });
  await writeFile(cliSettingsPath(env), "invalid-new-settings");
  await expect(readCliSettings(env)).rejects.toThrow("Unable to read");
  expect(await readFile(cliSettingsPath(env), "utf8")).toBe("invalid-new-settings");
  await rm(cliSettingsPath(env));
  expect((await readCliSettings(env)).ui).toMatchObject({ theme: "auto" });
});

test("uses Desktop's data directory and honors an explicit provider file", async () => {
  const { home, env } = await fixture();
  const data = join(home, "desktop-data");
  await writeFile(desktopSettingsPath(env), JSON.stringify({ dataBaseDir: data }));
  expect(providerConfigPath(env)).toBe(join(data, ".zcode/v2/provider_config.json"));
  expect(providerConfigPath({ ...env, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/custom/providers.json" })).toBe("/custom/providers.json");
  await writeFile(desktopSettingsPath(env), "invalid-desktop-settings");
  expect(() => providerConfigPath(env)).toThrow("Unable to read Desktop setting.json");
});
