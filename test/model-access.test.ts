import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeProviderFixture } from "./fixtures/provider-config.ts";

import { readConfiguredModelAccess, providerConfigPath, providerConfigPathHint } from "../src/model-access.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-model-access-"));
  temporaryDirectories.push(home);
  return home;
}

describe("configured model access", () => {
  test("reads registry defaults and account credential presence after native login", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    const directory = join(home, ".zcode", "v2");
    await mkdir(directory, { recursive: true });
    const configPath = join(directory, "provider_config.json");
    const providerId = "account:zai-individual-coding-plan";
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, config: {
      defaultModelSelection: { providerId, modelId: "GLM-5.3" },
      providerConfigRules: { providerRules: [] }
    } }));
    expect(await readConfiguredModelAccess(env)).toBeNull();
    await writeFile(join(directory, "credentials.json"), JSON.stringify({
      [`account-provider:${providerId}:identity`]: "opaque-encrypted-identity",
      [`account-provider:coding-plan:${providerId}:account:fixture-user:api-key`]: "opaque-encrypted-key"
    }));
    expect(await readConfiguredModelAccess(env)).toEqual({ configPath, providerId, model: `${providerId}/GLM-5.3` });
    await writeFile(join(directory, "credentials.json"), JSON.stringify({
      [`account-provider:${providerId}:identity`]: "opaque-encrypted-identity",
      "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:fixture-user:api-key": "different-provider"
    }));
    expect(await readConfiguredModelAccess(env)).toBeNull();
  });

  test("uses personal registry config as authoritative after migration", async () => {
    const home = await temporaryHome();
    const configPath = join(home, "personal.json");
    const env = { HOME: home, USERPROFILE: home, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: configPath };
    const config = { defaultModelSelection: { providerId: "custom", modelId: "org/model" },
      providerConfigRules: { providerRules: [{ providerId: "custom", config: { access: { apiKey: "configured" }, personalModelIds: ["org/model"] } }] }
    };
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, config }));
    expect(await readConfiguredModelAccess(env)).toEqual({ configPath, providerId: "custom", model: "custom/org/model" });
    config.providerConfigRules.providerRules[0]!.config.access.apiKey = "";
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, config }));
    expect(await readConfiguredModelAccess(env)).toBeNull();
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, config }));
    expect(await readConfiguredModelAccess(env)).toBeNull();
  });

  test("formats the config path hint for each supported platform", () => {
    expect(providerConfigPathHint("linux")).toBe("~/.zcode/v2/provider_config.json");
    expect(providerConfigPathHint("darwin")).toBe("~/.zcode/v2/provider_config.json");
    expect(providerConfigPathHint("win32")).toBe("%USERPROFILE%\\.zcode\\v2\\provider_config.json");
  });

  test("detects custom registry providers and rejects missing keys or models", async () => {
    const home = await temporaryHome(), env = { HOME: home, USERPROFILE: home };
    const { config, path } = await writeProviderFixture(env, { providerId: "custom", modelId: "org/model", apiKey: "fixture-key" });
    expect(await readConfiguredModelAccess(env)).toEqual({ configPath: path, providerId: "custom", model: "custom/org/model" });
    config.config.defaultModelSelection.modelId = "missing";
    await writeFile(path, JSON.stringify(config));
    expect(await readConfiguredModelAccess(env)).toBeNull();
    await writeProviderFixture(env, { providerId: "custom", modelId: "org/model" });
    expect(await readConfiguredModelAccess(env)).toBeNull();
    await writeFile(path, "not-json");
    expect(await readConfiguredModelAccess(env)).toBeNull();
  });
});
