import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ensureCliSettings,
  readConfiguredModelAccess,
  cliSettingsPath
} from "../src/model-access.ts";
import { credentialsPath, desktopSettingsPath, legacyCliConfigPath, settingsMigrationMarkerPath } from "../src/config-paths.ts";

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

});

describe("account provider model access", () => {

  async function accountAccess(
    providerId: string,
    modelId: string,
    credentials: Record<string, string>
  ): Promise<{ env: NodeJS.ProcessEnv; result: Awaited<ReturnType<typeof readConfiguredModelAccess>> }> {
    const home = await temporaryHome();
    const env = homeEnvironment(home);
    const providerPath = join(home, ".zcode", "v2", "provider_config.json");
    await mkdir(dirname(providerPath), { recursive: true });
    await writeFile(providerPath, `${JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: { providerId, modelId }
      }
    }, null, 2)}\n`);
    await writeFile(credentialsPath(env), `${JSON.stringify(credentials, null, 2)}\n`);
    return { env, result: await readConfiguredModelAccess(env) };
  }

  test("recognizes an OAuth Coding Plan account without a per-account API key", async () => {
    // Regression for #264: OAuth login stores identity/auth-source plus the
    // shared family session, never an account-scoped Coding Plan API key.
    const { env, result } = await accountAccess(
      "account:zai-individual-coding-plan",
      "GLM-5.3",
      {
        "oauth:active_provider": "enc:v1:active",
        "oauth:zai:access_token": "enc:v1:access",
        zcodejwttoken: "enc:v1:jwt",
        "oauth:zai:user_info": "enc:v1:profile",
        "account-provider:account:zai-individual-coding-plan:identity": "enc:v1:identity",
        "account-provider:account:zai-individual-coding-plan:auth-source": "enc:v1:oauth"
      }
    );

    expect(result).toEqual({
      configPath: join(env.HOME!, ".zcode", "v2", "provider_config.json"),
      model: "account:zai-individual-coding-plan/GLM-5.3",
      providerId: "account:zai-individual-coding-plan"
    });
  });

  test("recognizes a Start Plan model from the shared family session", async () => {
    // Start Plan providers own neither an identity nor an API key; the family
    // Coding Plan identity and OAuth session are reused (runtime behavior).
    const { result } = await accountAccess("account:zai-start-plan", "GLM-5.3-Flash", {
      "oauth:zai:access_token": "enc:v1:access",
      zcodejwttoken: "enc:v1:jwt",
      "account-provider:account:zai-individual-coding-plan:identity": "enc:v1:identity",
      "account-provider:account:zai-individual-coding-plan:auth-source": "enc:v1:oauth"
    });

    expect(result?.model).toBe("account:zai-start-plan/GLM-5.3-Flash");
  });

  test("recognizes a BigModel OAuth session", async () => {
    const { result } = await accountAccess(
      "account:bigmodel-individual-coding-plan",
      "GLM-5.3",
      {
        "oauth:bigmodel:access_token": "enc:v1:access",
        zcodejwttoken: "enc:v1:jwt"
      }
    );

    expect(result?.model).toBe("account:bigmodel-individual-coding-plan/GLM-5.3");
  });

  test("keeps manual Coding Plan API keys working", async () => {
    const { result } = await accountAccess(
      "account:zai-individual-coding-plan",
      "GLM-5.3",
      {
        "account-provider:account:zai-individual-coding-plan:identity": "enc:v1:identity",
        "account-provider:account:zai-individual-coding-plan:auth-source": "enc:v1:manual",
        "account-provider:coding-plan:account:zai-individual-coding-plan:account:user%40example.com:api-key": "enc:v1:key"
      }
    );

    expect(result?.providerId).toBe("account:zai-individual-coding-plan");
  });

  test("does not report access from an identity or an unrelated family session alone", async () => {
    const identityOnly = await accountAccess(
      "account:zai-individual-coding-plan",
      "GLM-5.3",
      { "account-provider:account:zai-individual-coding-plan:identity": "enc:v1:identity" }
    );
    const otherFamily = await accountAccess(
      "account:zai-individual-coding-plan",
      "GLM-5.3",
      { "oauth:bigmodel:access_token": "enc:v1:access", zcodejwttoken: "enc:v1:jwt" }
    );

    expect(identityOnly.result).toBeNull();
    expect(otherFamily.result).toBeNull();
  });

});
