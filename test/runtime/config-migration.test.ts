import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cliSettingsPath, legacyCliConfigPath, providerConfigPath, providerMigrationMarkerPath } from "../../src/config-paths.ts";
import { writeProviderFixture } from "../fixtures/provider-config.ts";

test("startup migrates personal providers once using native schema and conflict rules", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-shared-migration-"));
  const env = { HOME: home, USERPROFILE: home };
  const old = legacyCliConfigPath(env), target = providerConfigPath(env);
  const legacy = {
    provider: {
      existing: { kind: "openai-compatible", options: { apiKey: "old-conflicting-key", baseURL: "https://old.test/v1" }, models: { old: {} } },
      local: { kind: "openai-compatible", enabled: false, options: { apiKey: "local-key", baseURL: "https://local.test/v1" }, models: { chosen: { limit: { context: 64000 } }, preserved: { limit: { context: 64000 } }, deleted: { deleted: true } } },
      "account:zai-individual-coding-plan": { options: { apiKey: "account-secret" }, models: { "GLM-5.3": {} } },
      encrypted: { options: { apiKey: "enc:v1:opaque" }, models: { hidden: {} } }
    },
    model: { main: "local/chosen", lite: "local/chosen" },
    modelCatalog: { overrides: {} },
    ui: { tuiMode: "fullscreen", notifications: { method: "off" } },
    modelStream: { idleTimeoutMs: 90000 }
  };
  await mkdir(dirname(old), { recursive: true });
  await writeFile(old, JSON.stringify(legacy));
  const { config } = await writeProviderFixture(env, { providerId: "existing", modelId: "chosen", apiKey: "desktop-key" });
  const preservedOverride = { providerId: "local", modelId: "preserved", config: { properties: { contextWindow: 128000 } } };
  await writeFile(target, JSON.stringify({ ...config, config: { ...config.config, modelConfigRules: {
    ...config.config.modelConfigRules, providerModelRules: [preservedOverride]
  } } }));
  const run = async () => {
    const child = Bun.spawn([Bun.which("node")!, join(import.meta.dir, "../../bin/zcode.js"), "--help"], {
      env: { ...process.env, ...env, ZCODE_DISABLE_UPDATE_CHECK: "1" }, cwd: home,
      stdout: "pipe", stderr: "pipe"
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).not.toContain("local-key");
    expect(code, stderr).toBe(0);
    return stdout;
  };
  try {
    await run();
    const saved = JSON.parse(await readFile(target, "utf8"));
    const rules = saved.config.providerConfigRules.providerRules;
    expect(rules.map((rule: { providerId: string }) => rule.providerId)).toEqual(["existing", "local"]);
    expect(rules[0]).toEqual(config.config.providerConfigRules.providerRules[0]);
    expect(rules[1]).toMatchObject({ enabled: false, config: { personalModelIds: ["chosen", "preserved"], access: { apiKey: "local-key" } } });
    expect(saved.config.defaultModelSelection).toEqual(config.config.defaultModelSelection);
    expect(saved.config.modelConfigRules.providerModelRules).toEqual(expect.arrayContaining([
      preservedOverride,
      expect.objectContaining({ providerId: "local", modelId: "chosen", config: { properties: { contextWindow: 64000 } } })
    ]));
    expect(JSON.parse(await readFile(cliSettingsPath(env), "utf8"))).toEqual({ ui: legacy.ui, modelStream: legacy.modelStream });
    expect(JSON.parse(await readFile(old, "utf8"))).toEqual(legacy);
    expect(JSON.parse(await readFile(providerMigrationMarkerPath(env), "utf8"))).toMatchObject({ imported: ["local"] });
    saved.config.providerConfigRules.providerRules.pop();
    await writeFile(target, JSON.stringify(saved));
    const before = await readFile(target, "utf8");
    await run();
    expect(await readFile(target, "utf8")).toBe(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15000);

test.each(["invalid-json", JSON.stringify({ schemaVersion: 99, config: {} })])("migration preserves invalid shared configuration (%s)", async (contents) => {
  const home = await mkdtemp(join(tmpdir(), "zcode-migration-invalid-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: home, ZCODE_CLI_MIGRATE_CONFIG: "1" };
  try {
    await mkdir(dirname(legacyCliConfigPath(env)), { recursive: true });
    await writeFile(legacyCliConfigPath(env), JSON.stringify({ provider: {
      custom: { kind: "openai-compatible", options: { apiKey: "secret-fixture", baseURL: "https://example.test" }, models: { model: {} } }
    } }));
    await mkdir(dirname(providerConfigPath(env)), { recursive: true });
    await writeFile(providerConfigPath(env), contents);
    const child = Bun.spawn([Bun.which("node")!, join(import.meta.dir, "../../vendor/zcode.cjs"), "--version"], { env, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("left unchanged");
    expect(stderr).not.toContain("secret-fixture");
    expect(await readFile(providerConfigPath(env), "utf8")).toBe(contents);
    expect(await Bun.file(providerMigrationMarkerPath(env)).exists()).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent startup migration cannot duplicate personal providers", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-migration-concurrent-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: home, ZCODE_CLI_MIGRATE_CONFIG: "1" };
  try {
    await mkdir(dirname(legacyCliConfigPath(env)), { recursive: true });
    await writeFile(legacyCliConfigPath(env), JSON.stringify({ provider: {
      custom: { kind: "openai-compatible", options: { apiKey: "secret-fixture", baseURL: "https://example.test" }, models: { model: {} } }
    } }));
    const exits = await Promise.all([0, 1].map(async () => {
      const child = Bun.spawn([Bun.which("node")!, join(import.meta.dir, "../../vendor/zcode.cjs"), "--version"], { env, stdout: "pipe", stderr: "pipe" });
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code, error).toBe(0);
      return code;
    }));
    expect(exits).toEqual([0, 0]);
    const saved = JSON.parse(await readFile(providerConfigPath(env), "utf8"));
    expect(saved.config.providerConfigRules.providerRules.map((rule: { providerId: string }) => rule.providerId)).toEqual(["custom"]);
    expect(saved.config.defaultModelSelection).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
