import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import defaultUserConfig from "../config.example.json" with { type: "json" };
import {
  applyDesktopMigration,
  desktopConfigPath,
  detectDesktopInstallation
} from "../src/desktop-migration.ts";
import {
  clearSetupPending,
  markSetupPending,
  readConfiguredModelAccess,
  readSetupPending,
  setupPendingPath,
  userConfigPath
} from "../src/model-access.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-desktop-migration-"));
  temporaryDirectories.push(home);
  return home;
}

const desktopConfig = {
  provider: {
    "builtin:zai-coding-plan": {
      name: "Z.ai - Coding Plan",
      kind: "anthropic",
      options: { baseURL: "https://api.z.ai/api/anthropic", apiKey: "" },
      enabled: false,
      systemDisabledReason: "coding_plan_not_entitled",
      models: {
        "GLM-5.3": { name: "GLM-5.3" },
        "GLM-5.2": { name: "GLM-5.2" },
        "GLM-5-Turbo": { name: "GLM-5-Turbo" }
      }
    },
    "builtin:bigmodel-coding-plan": {
      name: "BigModel - Coding Plan",
      kind: "anthropic",
      options: { baseURL: "https://open.bigmodel.cn/api/anthropic", apiKey: "" },
      models: {
        "GLM-5.3": { name: "GLM-5.3" }
      }
    },
    "9b37c199-593a-4b34-ad6e-36ed4f09f755": {
      name: "Custom endpoint",
      kind: "anthropic",
      options: { baseURL: "https://example.invalid/api", apiKey: "sk-desktop-secret" },
      models: { "custom-model": { name: "Custom" } }
    }
  }
};

const desktopSetting = {
  locale: "zh-CN",
  modelProviderFamilyModes: { zai: "oauth", bigmodel: "oauth" },
  modelProviderFamilySelectedKeys: {
    zai: "coding-plan:builtin:zai-coding-plan",
    bigmodel: "coding-plan:builtin:bigmodel-coding-plan"
  },
  providerFamilyDomain: "zai"
};

async function writeDesktopHome(home: string, options: { setting?: boolean } = {}): Promise<void> {
  await mkdir(join(home, ".zcode", "v2"), { recursive: true });
  await writeFile(
    join(home, ".zcode", "v2", "config.json"),
    JSON.stringify(desktopConfig)
  );
  if (options.setting !== false) {
    await writeFile(
      join(home, ".zcode", "v2", "setting.json"),
      JSON.stringify(desktopSetting)
    );
  }
}

async function writeCliConfig(home: string): Promise<string> {
  const path = userConfigPath({ HOME: home, USERPROFILE: home });
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  await writeFile(path, JSON.stringify(defaultUserConfig));
  return path;
}

describe("desktop installation detection", () => {
  test("returns null when the desktop config is missing or invalid", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    expect(await detectDesktopInstallation(env)).toBeNull();

    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(desktopConfigPath(env), "not-json");
    expect(await detectDesktopInstallation(env)).toBeNull();
  });

  test("builds a migration plan with the selected family", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    await writeDesktopHome(home);

    const installation = await detectDesktopInstallation(env);
    expect(installation).not.toBeNull();
    expect(installation!.plan.defaultFamily).toBe("zai");
    expect(installation!.plan.families.map((entry) => entry.family)).toEqual(["zai", "bigmodel"]);
    const zai = installation!.plan.families[0]!;
    expect(zai.models.map((model) => model.id)).toEqual(["GLM-5.3", "GLM-5.2", "GLM-5-Turbo"]);
    expect(zai.baseURL).toBe("https://api.z.ai/api/anthropic");
  });
});

describe("desktop migration apply", () => {
  test("migrates provider and models without copying desktop credentials", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    await writeDesktopHome(home);
    const configPath = await writeCliConfig(home);

    const installation = await detectDesktopInstallation(env);
    const result = await applyDesktopMigration(installation!.plan, { env });

    expect(result.configPath).toBe(configPath);
    expect(result.backupPath).toBe(`${configPath}.pre-migration.bak`);

    const migrated = JSON.parse(await readFile(configPath, "utf8"));
    const provider = migrated.provider.zai;
    expect(provider.name).toBe("Z.ai - Coding Plan");
    expect(provider.options.baseURL).toBe("https://api.z.ai/api/anthropic");
    expect(provider.models["GLM-5.3"].name).toBe("GLM-5.3");
    expect(provider.models["glm-5.2"].name).toBe("GLM-5.2");
    expect(Object.keys(provider.models)).toContain("glm-5.1");
    expect(provider.options.apiKey).toBeUndefined();
    expect(migrated.model.main).toBe("zai/glm-5.2");
    expect(migrated.model.lite).toBe("zai/glm-5-turbo");
    for (const selected of [migrated.model.main, migrated.model.lite]) {
      const modelId = selected.split("/")[1]!;
      expect(provider.models[modelId]).toBeDefined();
    }

    const backup = JSON.parse(await readFile(result.backupPath!, "utf8"));
    expect(backup.model.main).toBe("zai/glm-5.2");
  });

  test("is idempotent and keeps an existing CLI apiKey", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    await writeDesktopHome(home);
    const configPath = await writeCliConfig(home);

    const installation = await detectDesktopInstallation(env);
    await applyDesktopMigration(installation!.plan, { env });
    await applyDesktopMigration(installation!.plan, { env });

    const migrated = JSON.parse(await readFile(configPath, "utf8"));
    const modelIds = Object.keys(migrated.provider.zai.models);
    expect(modelIds.filter((id) => id === "GLM-5.2").length).toBe(1);
    expect(migrated.provider.zai.options.apiKey).toBeUndefined();

    const withKey = JSON.parse(await readFile(configPath, "utf8"));
    withKey.provider.zai.options.apiKey = "cli-existing-key";
    await writeFile(configPath, JSON.stringify(withKey));

    await applyDesktopMigration(installation!.plan, { env });
    const reMigrated = JSON.parse(await readFile(configPath, "utf8"));
    expect(reMigrated.provider.zai.options.apiKey).toBe("cli-existing-key");
  });

  test("keeps the setup wizard pending until it is cleared", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    await writeCliConfig(home);

    expect(await readSetupPending(env)).toBe(false);
    await markSetupPending(env);
    expect(await readSetupPending(env)).toBe(true);
    expect(setupPendingPath(env)).toBe(join(home, ".zcode", "cli", "setup-pending"));
    await clearSetupPending(env);
    expect(await readSetupPending(env)).toBe(false);
  });

  test("clearing the pending marker mirrors what the TUI does once access exists", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    await writeCliConfig(home);
    await markSetupPending(env);

    // The wizard auto-start condition is: pending && !configuredAccess. After
    // `zcode login` writes an apiKey, the marker must be cleared so the wizard
    // does not reappear over a configured account.
    const configured = await readConfiguredModelAccess(env);
    expect(configured).toBeNull();
    const configuredPath = userConfigPath(env);
    const config = JSON.parse(await readFile(configuredPath, "utf8")) as {
      provider?: { zai?: { options?: { apiKey?: string } } };
    };
    config.provider!.zai!.options!.apiKey = "configured-by-login";
    await writeFile(configuredPath, JSON.stringify(config));

    expect(await readConfiguredModelAccess(env)).not.toBeNull();
    await clearSetupPending(env);
    expect(await readSetupPending(env)).toBe(false);
  });

  test("migrates an alternate family and picks models that exist after import", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    await writeDesktopHome(home);
    const configPath = await writeCliConfig(home);

    const installation = await detectDesktopInstallation(env);
    const result = await applyDesktopMigration(installation!.plan, { env, family: "bigmodel" });

    const migrated = JSON.parse(await readFile(configPath, "utf8"));
    expect(Object.keys(migrated.provider)).toContain("zai");
    // The desktop BigModel provider only offers GLM-5.3, so both selections must
    // resolve to a model that exists in the merged provider table.
    expect(migrated.model.main).toBe("bigmodel/GLM-5.3");
    expect(migrated.model.lite).toBe("bigmodel/GLM-5.3");
    for (const selected of [migrated.model.main, migrated.model.lite]) {
      const modelId = selected.split("/")[1]!;
      expect(migrated.provider.bigmodel.models[modelId]).toBeDefined();
    }

    const backup = JSON.parse(await readFile(result.backupPath, "utf8"));
    expect(backup.provider.bigmodel).toBeUndefined();
  });

  test("fails the import when the pre-migration backup cannot be written", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    await writeDesktopHome(home);
    const configPath = await writeCliConfig(home);

    // A directory at the backup path makes copyFile fail without touching the
    // original config.
    await mkdir(`${configPath}.pre-migration.bak`, { recursive: true });

    const installation = await detectDesktopInstallation(env);
    let failure: unknown;
    try {
      await applyDesktopMigration(installation!.plan, { env });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toContain("Unable to back up");
    const untouched = JSON.parse(await readFile(configPath, "utf8"));
    expect(untouched.provider.zai.models).toEqual(defaultUserConfig.provider.zai.models);
  });
});
