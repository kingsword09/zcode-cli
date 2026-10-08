import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ensureCliSettings,
  readConfiguredModelAccess,
  cliSettingsPath
} from "../src/model-access.ts";
import { desktopSettingsPath, legacyCliConfigPath, settingsMigrationMarkerPath } from "../src/config-paths.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-config-bootstrap-"));
  temporaryDirectories.push(home);
  return home;
}

function homeEnvironment(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home };
}

describe("user config bootstrap", () => {
  test("resolves the official config location on POSIX and Windows", () => {
    expect(cliSettingsPath({ HOME: "/home/alice" }, "linux", "/fallback")).toBe(
      "/home/alice/.zcode/cli/setting.json"
    );
    expect(cliSettingsPath({ USERPROFILE: "C:\\Users\\Alice" }, "win32", "C:\\fallback")).toBe(
      "C:\\Users\\Alice\\.zcode\\cli\\setting.json"
    );
    expect(cliSettingsPath({}, "win32", "D:\\Profiles\\Default")).toBe(
      "D:\\Profiles\\Default\\.zcode\\cli\\setting.json"
    );
  });

  test("lets a host choose the settings file without moving Desktop settings", async () => {
    const home = await temporaryHome();
    const hostFile = join(home, "host", "card", "setting.json");
    const env = { ...homeEnvironment(home), ZCODE_CLI_SETTINGS_FILE: ` ${hostFile} ` };

    expect(cliSettingsPath(env)).toBe(hostFile);
    expect(desktopSettingsPath(env)).toBe(join(home, ".zcode", "v2", "setting.json"));
    expect(await ensureCliSettings(env)).toEqual({ configPath: hostFile, created: true });
    expect(JSON.parse(await readFile(hostFile, "utf8"))).toBeObject();
    await expect(stat(join(home, ".zcode", "cli", "setting.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("supports Windows overrides and ignores blank values", () => {
    expect(cliSettingsPath({ ZCODE_CLI_SETTINGS_FILE: " C:\\Host\\card.json " }, "win32", "D:\\Default"))
      .toBe("C:\\Host\\card.json");
    expect(cliSettingsPath({ HOME: "/home/alice", ZCODE_CLI_SETTINGS_FILE: " \t " }, "linux", "/fallback"))
      .toBe("/home/alice/.zcode/cli/setting.json");
  });

  test("migrates and resets host settings independently of the home migration", async () => {
    const home = await temporaryHome(), homeEnv = homeEnvironment(home);
    await ensureCliSettings(homeEnv);
    const original = await readFile(cliSettingsPath(homeEnv), "utf8");
    const originalMarker = await readFile(settingsMigrationMarkerPath(homeEnv), "utf8");
    await writeFile(legacyCliConfigPath(homeEnv), "invalid home legacy config");

    const env = { ...homeEnv, ZCODE_CLI_SETTINGS_FILE: join(home, "host", "card.json") };
    await mkdir(dirname(legacyCliConfigPath(env)), { recursive: true });
    const hooks = { enabled: true, events: {} };
    await writeFile(legacyCliConfigPath(env), JSON.stringify({ hooks, provider: { old: {} } }));
    expect(await ensureCliSettings(env)).toEqual({ configPath: cliSettingsPath(env), created: true, migrated: true });
    expect(JSON.parse(await readFile(cliSettingsPath(env), "utf8"))).toEqual({ hooks });
    expect(JSON.parse(await readFile(settingsMigrationMarkerPath(env), "utf8"))).toEqual({ schemaVersion: 1 });

    await rm(cliSettingsPath(env));
    await writeFile(legacyCliConfigPath(env), "invalid host legacy config after migration");
    expect(await ensureCliSettings(env)).toEqual({ configPath: cliSettingsPath(env), created: true });
    expect(JSON.parse(await readFile(cliSettingsPath(env), "utf8")).hooks.enabled).toBe(false);
    expect(await readFile(cliSettingsPath(homeEnv), "utf8")).toBe(original);
    expect(await readFile(settingsMigrationMarkerPath(homeEnv), "utf8")).toBe(originalMarker);
  });

  test("recursively creates a private, credential-free config", async () => {
    const home = await temporaryHome();
    const env = homeEnvironment(home);
    const result = await ensureCliSettings(env);
    const config = JSON.parse(await readFile(result.configPath, "utf8")) as {
      model?: unknown;
      modelStream: { idleTimeoutMs: number };
      provider?: unknown;
      subagents: { autoBackgroundMs: number };
    };

    expect(result).toEqual({ configPath: cliSettingsPath(env), created: true });
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
    expect(config.modelStream.idleTimeoutMs).toBe(60_000);
    expect(config.subagents.autoBackgroundMs).toBe(1_000);
    expect(await readConfiguredModelAccess(env)).toBeNull();

    if (process.platform !== "win32") {
      expect((await stat(dirname(result.configPath))).mode & 0o077).toBe(0);
      expect((await stat(result.configPath)).mode & 0o077).toBe(0);
    }
  });

  test("never overwrites an existing user config", async () => {
    const home = await temporaryHome();
    const env = homeEnvironment(home);
    const configPath = cliSettingsPath(env);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "user-owned-config\n");
    if (process.platform !== "win32") await chmod(configPath, 0o644);

    expect(await ensureCliSettings(env)).toEqual({ configPath, created: false });
    expect(await readFile(configPath, "utf8")).toBe("user-owned-config\n");
    if (process.platform !== "win32") expect((await stat(configPath)).mode & 0o777).toBe(0o644);
  });

  test("allows only one concurrent startup to create the config", async () => {
    const home = await temporaryHome();
    const env = homeEnvironment(home);
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureCliSettings(env)));
    const serialized = await readFile(cliSettingsPath(env), "utf8");

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) => result.configPath === cliSettingsPath(env))).toBe(true);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  test("rejects a config path occupied by a directory", async () => {
    const home = await temporaryHome();
    const env = homeEnvironment(home);
    await mkdir(cliSettingsPath(env), { recursive: true });

    await expect(ensureCliSettings(env)).rejects.toThrow(/exists but is not a file/u);
  });
});
