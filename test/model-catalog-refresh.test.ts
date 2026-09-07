import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import defaultUserConfig from "../config.example.json" with { type: "json" };
import {
  applyRefreshedModelsToConfig,
  fetchRemoteModelCatalog,
  modelCatalogCachePath,
  modelCatalogRefreshDisabled,
  ModelCatalogRefresh,
  MODEL_CATALOG_REFRESH_TTL_MS,
  MODEL_CATALOG_URL_PATH,
  refreshModelCatalog,
  resolveModelCatalogEndpoint
} from "../src/model-catalog-refresh.ts";
import { ensureUserConfig, userConfigPath } from "../src/model-access.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-model-catalog-"));
  temporaryDirectories.push(home);
  return home;
}

async function writeCatalogCache(
  cachePath: string,
  builtinModels: unknown[],
  builtinProviders: unknown[],
  lastFetchedAt: string
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify({
    endpoint: resolveModelCatalogEndpoint("https://zcode.z.ai", { ZCODE_APP_CLI_VERSION: "3.11.2-21" }),
    lastFetchedAt,
    builtinModels,
    builtinProviders
  })}\n`);
}

const sampleBuiltinModels = [
  {
    modelId: "GLM-5.3",
    name: "GLM-5.3",
    contextWindow: 1_000_000,
    maxCompletionTokens: 128_000,
    reasoning: {
      levels: Object.fromEntries(["low", "high", "max"].map((effort) => [effort, {
        anthropic: { set: [{ path: ["output_config", "effort"], value: effort }] }
      }])),
      defaultLevel: "max"
    },
    modalities: { input: ["text"], output: ["text"] }
  },
  {
    modelId: "GLM-5.3-Flash",
    name: "GLM-5.3-Flash",
    contextWindow: 1_000_000,
    maxCompletionTokens: 128_000,
    capabilities: { vision: true },
    reasoning: { levels: { low: {}, high: {}, max: {} }, defaultLevel: "max" },
    modalities: { input: ["text", "image", "video"], output: ["text"] }
  }
];

const sampleBuiltinProviders = [
  { id: "builtin:zai-coding-plan", name: "Z.ai - Coding Plan", models: ["GLM-5.3", "GLM-5.3-Flash"], defaultModel: "GLM-5.3" },
  { id: "builtin:bigmodel-coding-plan", name: "BigModel - Coding Plan", models: ["GLM-5.3", "GLM-5.3-Flash"], defaultModel: "GLM-5.3" }
];

function mockFetcher(responseBody: unknown, status = 200): (url: string, init: RequestInit) => Promise<Response> {
  return async (_url, _init) => new Response(JSON.stringify(responseBody), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("model catalog refresh — opt-out and paths", () => {
  test("respects standard opt-out flags", () => {
    expect(modelCatalogRefreshDisabled({})).toBe(false);
    expect(modelCatalogRefreshDisabled({ CI: "true" })).toBe(true);
    expect(modelCatalogRefreshDisabled({ ZCODE_DISABLE_MODEL_CATALOG_REFRESH: "1" })).toBe(true);
    expect(modelCatalogRefreshDisabled({ ZCODE_DISABLE_MODEL_CATALOG_REFRESH: "false" })).toBe(false);
  });

  test("uses the cross-platform config directory", () => {
    expect(modelCatalogCachePath({ HOME: "/home/alice" }, "linux", "/fallback")).toBe(
      "/home/alice/.zcode/cli/model-catalog.json"
    );
    expect(modelCatalogCachePath({ USERPROFILE: "C:\\Users\\Alice" }, "win32", "C:\\fallback")).toBe(
      "C:\\Users\\Alice\\.zcode\\cli\\model-catalog.json"
    );
  });
});

describe("model catalog refresh — endpoint resolution", () => {
  test("builds the endpoint URL with platform, arch, and app_version", () => {
    const url = resolveModelCatalogEndpoint(
      "https://zcode.z.ai",
      { ZCODE_APP_CLI_VERSION: "3.11.2-21" },
      "darwin",
      "arm64"
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://zcode.z.ai");
    expect(parsed.pathname).toBe(MODEL_CATALOG_URL_PATH);
    expect(parsed.searchParams.get("platform")).toBe("darwin-arm64");
    expect(parsed.searchParams.get("app_version")).toBe("3.11.2-21");
  });

  test("strips a trailing slash from the base URL", () => {
    const url = resolveModelCatalogEndpoint("https://zcode.z.ai/", {}, "linux", "x64");
    expect(new URL(url).origin).toBe("https://zcode.z.ai");
  });

  test("omits app_version when not set", () => {
    const url = resolveModelCatalogEndpoint("https://zcode.z.ai", {}, "darwin", "arm64");
    expect(new URL(url).searchParams.get("app_version")).toBeNull();
  });
});

describe("model catalog refresh — fetchRemoteModelCatalog", () => {
  test("parses builtinModels and builtinProviders from a successful response", async () => {
    const remote = await fetchRemoteModelCatalog({
      baseUrl: "https://zcode.z.ai",
      currentVersion: "3.11.2-21",
      env: { ZCODE_APP_CLI_VERSION: "3.11.2-21" },
      fetcher: mockFetcher({ code: 0, msg: "", data: { builtinModels: sampleBuiltinModels, builtinProviders: sampleBuiltinProviders } })
    });
    expect(remote.builtinModels).toHaveLength(2);
    expect(remote.builtinModels?.[0]?.modelId).toBe("GLM-5.3");
    expect(remote.builtinProviders).toHaveLength(2);
  });

  test("returns empty on a non-zero code", async () => {
    const remote = await fetchRemoteModelCatalog({
      baseUrl: "https://zcode.z.ai",
      currentVersion: "3.11.2-21",
      fetcher: mockFetcher({ code: 3001, msg: "parameter error" })
    });
    expect(remote.builtinModels ?? []).toHaveLength(0);
  });

  test("returns empty on an HTTP error", async () => {
    const remote = await fetchRemoteModelCatalog({
      baseUrl: "https://zcode.z.ai",
      currentVersion: "3.11.2-21",
      fetcher: async () => new Response("unavailable", { status: 503 })
    });
    expect(remote.builtinModels ?? []).toHaveLength(0);
  });
});

describe("model catalog refresh — refreshModelCatalog cache", () => {
  test("skips fetching when a fresh cache exists", async () => {
    const home = await temporaryHome();
    const cachePath = modelCatalogCachePath({ HOME: home, USERPROFILE: home });
    const now = Date.parse("2026-09-07T12:00:00.000Z");
    await writeCatalogCache(cachePath, sampleBuiltinModels, sampleBuiltinProviders, new Date(now - 60_000).toISOString());

    let fetched = false;
    const result = await refreshModelCatalog({
      baseUrl: "https://zcode.z.ai",
      currentVersion: "3.11.2-21",
      env: { HOME: home, USERPROFILE: home },
      fetcher: async () => { fetched = true; return new Response("{}", { status: 200 }); },
      now
    });
    expect(fetched).toBe(false);
    expect(result.refreshed).toBe(false);
    expect(result.catalog?.builtinModels).toHaveLength(2);
  });

  test("fetches and writes a new cache when the TTL has expired", async () => {
    const home = await temporaryHome();
    const cachePath = modelCatalogCachePath({ HOME: home, USERPROFILE: home });
    const now = Date.parse("2026-09-07T12:00:00.000Z");
    await writeCatalogCache(cachePath, [], [], new Date(now - MODEL_CATALOG_REFRESH_TTL_MS - 1).toISOString());

    const result = await refreshModelCatalog({
      baseUrl: "https://zcode.z.ai",
      currentVersion: "3.11.2-21",
      env: { HOME: home, USERPROFILE: home, ZCODE_APP_CLI_VERSION: "3.11.2-21" },
      fetcher: mockFetcher({ code: 0, msg: "", data: { builtinModels: sampleBuiltinModels, builtinProviders: sampleBuiltinProviders } }),
      now
    });
    expect(result.refreshed).toBe(true);
    expect(result.catalog?.builtinModels).toHaveLength(2);

    const persisted = JSON.parse(await readFile(cachePath, "utf8"));
    expect(persisted.builtinModels).toHaveLength(2);
    expect(persisted.lastFetchedAt).toBe(new Date(now).toISOString());
  });

  test("does not overwrite an existing cache when the remote returns nothing", async () => {
    const home = await temporaryHome();
    const cachePath = modelCatalogCachePath({ HOME: home, USERPROFILE: home });
    const now = Date.parse("2026-09-07T12:00:00.000Z");
    await writeCatalogCache(cachePath, sampleBuiltinModels, sampleBuiltinProviders, new Date(now - MODEL_CATALOG_REFRESH_TTL_MS - 1).toISOString());

    const before = await readFile(cachePath, "utf8");
    const result = await refreshModelCatalog({
      baseUrl: "https://zcode.z.ai",
      currentVersion: "3.11.2-21",
      env: { HOME: home, USERPROFILE: home },
      fetcher: async () => new Response("{}", { status: 503 }),
      now
    });
    expect(result.refreshed).toBe(false);
    expect(await readFile(cachePath, "utf8")).toBe(before);
  });
});

describe("model catalog refresh — applyRefreshedModelsToConfig", () => {
  test("merges new models into provider.zai.models without removing existing entries", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    await ensureUserConfig(env);
    const configPath = userConfigPath(env);

    const before = JSON.parse(await readFile(configPath, "utf8")) as { provider: Record<string, { models: Record<string, unknown> }> };
    expect(Object.keys(before.provider.zai?.models ?? {})).toContain("glm-5.2");

    const result = {
      cachePath: modelCatalogCachePath(env, "linux", home),
      refreshed: true,
      catalog: {
        lastFetchedAt: new Date().toISOString(),
        builtinModels: sampleBuiltinModels,
        builtinProviders: sampleBuiltinProviders
      }
    };
    await applyRefreshedModelsToConfig(result, env);

    const after = JSON.parse(await readFile(configPath, "utf8")) as { provider: Record<string, { models: Record<string, unknown> }> };
    const zaiModels = after.provider.zai?.models ?? {};
    expect(Object.keys(zaiModels)).toContain("glm-5.2");
    expect(Object.keys(zaiModels)).toContain("glm-5.3");
    expect(Object.keys(zaiModels)).toContain("glm-5.3-flash");
    expect(Object.keys(zaiModels)).toContain("glm-5-turbo");
  });

  test("preserves user-customized name fields while adding metadata", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    await ensureUserConfig(env);
    const configPath = userConfigPath(env);

    const customName = "My Custom Model";
    await writeFile(configPath, JSON.stringify({
      ...defaultUserConfig,
      provider: {
        zai: {
          ...defaultUserConfig.provider.zai,
          models: {
            ...defaultUserConfig.provider.zai.models,
            "glm-5.3": { name: customName }
          }
        }
      }
    }, null, 2));

    const result = {
      cachePath: modelCatalogCachePath(env, "linux", home),
      refreshed: true,
      catalog: {
        lastFetchedAt: new Date().toISOString(),
        builtinModels: sampleBuiltinModels,
        builtinProviders: sampleBuiltinProviders
      }
    };
    await applyRefreshedModelsToConfig(result, env);

    const after = JSON.parse(await readFile(configPath, "utf8")) as { provider: Record<string, { models: Record<string, { name: string; limit?: unknown }> }> };
    const entry = after.provider.zai?.models?.["glm-5.3"];
    expect(entry?.name).toBe(customName);
    expect(entry?.limit).toBeDefined();
  });

  test("does not modify config when the catalog is empty", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home };
    await ensureUserConfig(env);
    const configPath = userConfigPath(env);
    const before = await readFile(configPath, "utf8");

    await applyRefreshedModelsToConfig({
      cachePath: modelCatalogCachePath(env, "linux", home),
      refreshed: false,
      catalog: null
    }, env);

    expect(await readFile(configPath, "utf8")).toBe(before);
  });
});

function catalogResult(env: NodeJS.ProcessEnv, ids = ["GLM-6"]) {
  return {
    cachePath: modelCatalogCachePath(env),
    refreshed: true,
    catalog: {
      retirementSafe: true,
      lastFetchedAt: new Date().toISOString(),
      builtinModels: ids.map((modelId) => ({ ...sampleBuiltinModels[0]!, modelId, name: modelId })),
      builtinProviders: [{ id: "builtin:zai-coding-plan", models: ids }]
    }
  };
}

async function configuredHome() {
  const home = await temporaryHome();
  const env = { HOME: home, USERPROFILE: home };
  await ensureUserConfig(env);
  return env;
}

async function readConfig(env: NodeJS.ProcessEnv) {
  return JSON.parse(await readFile(userConfigPath(env), "utf8"));
}

describe("model catalog validation and fallback", () => {
  test("validates remote records before caching or writing runtime metadata", async () => {
    const remote = await fetchRemoteModelCatalog({
      baseUrl: "https://zcode.z.ai", currentVersion: "3.11.2-21",
      fetcher: mockFetcher({ code: 0, data: {
        builtinModels: [null, {}, { modelId: 42 }, { modelId: "__proto__" }, {
          modelId: "GLM-6", contextWindow: -1, maxCompletionTokens: 0,
          modalities: { input: ["image", "future-format", 7], output: "text" }
        }],
        builtinProviders: [null, {}, { id: 7 }, { id: "builtin:zai-coding-plan", models: [null, "GLM-6"] }]
      } })
    });
    expect(remote.builtinModels).toEqual([{
      modelId: "GLM-6", name: "GLM-6", modalities: { input: ["image"] }
    }]);
    expect(remote.builtinProviders).toEqual([{ id: "builtin:zai-coding-plan", models: ["GLM-6"] }]);
  });

  test("uses the actual package version and tolerates invalid endpoints and JSON", async () => {
    let requested = "";
    await fetchRemoteModelCatalog({
      baseUrl: "https://zcode.z.ai/prefix///?channel=stable#unused", currentVersion: "3.11.2-21", env: {},
      fetcher: async (url, init) => {
        requested = url;
        expect(new Headers(init.headers).get("user-agent")).toBe("zcode-app-cli/3.11.2-21");
        return new Response("not json");
      }
    });
    expect(new URL(requested).searchParams.get("app_version")).toBe("3.11.2-21");
    expect(new URL(requested).pathname).toBe(`/prefix${MODEL_CATALOG_URL_PATH}`);
    expect(new URL(requested).hash).toBe("");
    expect(await fetchRemoteModelCatalog({ baseUrl: "not a url", currentVersion: "1" })).toEqual({});
    expect(await fetchRemoteModelCatalog({
      baseUrl: "https://zcode.z.ai", currentVersion: "1",
      fetcher: mockFetcher({ code: "failure", data: catalogResult({}).catalog })
    })).toEqual({});
  });

  test("bounds slow requests and honors cancellation before requesting", async () => {
    let cancelled = false;
    const remote = await fetchRemoteModelCatalog({
      baseUrl: "https://zcode.z.ai", currentVersion: "1", timeoutMs: 10,
      fetcher: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => { cancelled = true; reject(init.signal!.reason); }, { once: true });
      })
    });
    expect(cancelled).toBe(true);
    expect(remote).toEqual({});
    await fetchRemoteModelCatalog({
      baseUrl: "https://zcode.z.ai", currentVersion: "1", signal: AbortSignal.abort(),
      fetcher: async () => { throw new Error("must not fetch"); }
    });
  });

  test("discards corrupted, future-dated and differently scoped caches", async () => {
    const env = await configuredHome();
    const cachePath = modelCatalogCachePath(env);
    const now = Date.now();
    for (const cache of [
      { lastFetchedAt: new Date(now).toISOString(), builtinModels: [null], builtinProviders: sampleBuiltinProviders },
      { lastFetchedAt: new Date(now + 86_400_000).toISOString(), builtinModels: sampleBuiltinModels, builtinProviders: sampleBuiltinProviders },
      { lastFetchedAt: new Date(now).toISOString(), builtinModels: sampleBuiltinModels, builtinProviders: sampleBuiltinProviders, endpoint: "https://other.test" }
    ]) {
      await writeFile(cachePath, JSON.stringify({
        endpoint: resolveModelCatalogEndpoint("https://zcode.z.ai", { ZCODE_APP_CLI_VERSION: "3.11.2-21" }), ...cache
      }));
      let fetched = false;
      const result = await refreshModelCatalog({
        baseUrl: "https://zcode.z.ai", currentVersion: "3.11.2-21", env, now,
        fetcher: async () => { fetched = true; return new Response("{}", { status: 503 }); }
      });
      expect(fetched).toBe(true);
      expect(result.refreshed).toBe(false);
    }
  });

  test("does not refresh or persist anything when disabled", async () => {
    const env = await configuredHome();
    let fetched = false;
    const result = await refreshModelCatalog({
      baseUrl: "https://zcode.z.ai", currentVersion: "1", env: { ...env, CI: "true" },
      fetcher: async () => { fetched = true; return new Response("{}"); }
    });
    expect(fetched).toBe(false);
    expect(result.catalog).toBeNull();
    expect(await Bun.file(result.cachePath).exists()).toBe(false);
  });
});

describe("safe model synchronization", () => {
  test("filters by Coding Plan membership and does not create missing providers", async () => {
    const env = await configuredHome();
    const result = catalogResult(env, ["GLM-6", "GLM-7", "GLM-8"]);
    result.catalog.builtinProviders = [
      { id: "builtin:zai-coding-plan", models: ["GLM-6"] },
      { id: "builtin:bigmodel-coding-plan", models: ["GLM-7"] },
      { id: "builtin:zai", models: ["GLM-8"] }
    ];
    await applyRefreshedModelsToConfig(result, env);
    const config = await readConfig(env);
    expect(config.provider.zai.models["glm-6"]).toBeDefined();
    expect(config.provider.zai.models["glm-7"]).toBeUndefined();
    expect(config.provider.zai.models["glm-8"]).toBeUndefined();
    expect(config.provider.bigmodel).toBeUndefined();
    expect(config.model).toEqual(defaultUserConfig.model);

    config.provider.bigmodel = {
      kind: "anthropic", options: { baseURL: "https://open.bigmodel.cn/api/anthropic", apiKey: "fixture-key" }, models: {}
    };
    await writeFile(userConfigPath(env), JSON.stringify(config));
    await applyRefreshedModelsToConfig(result, env);
    const afterLogin = await readConfig(env);
    expect(afterLogin.provider.bigmodel.models["glm-7"]).toBeDefined();
    expect(afterLogin.provider.bigmodel.models["glm-6"]).toBeUndefined();
    expect(afterLogin.provider.bigmodel.options.apiKey).toBe("fixture-key");
  });

  test("leaves custom endpoints and protocols untouched, including formatting", async () => {
    const env = await configuredHome();
    const config = await readConfig(env);
    for (const provider of [
      { ...config.provider.zai, options: { baseURL: "https://proxy.test/api/anthropic" } },
      { ...config.provider.zai, kind: "openai" },
      { models: {} }
    ]) {
      const before = JSON.stringify({ ...config, provider: { zai: provider } });
      await writeFile(userConfigPath(env), before);
      await applyRefreshedModelsToConfig(catalogResult(env), env);
      expect(await readFile(userConfigPath(env), "utf8")).toBe(before);
    }
  });

  test("preserves imported model casing and nested overrides and adds runtime reasoning", async () => {
    const env = await configuredHome();
    const config = await readConfig(env);
    config.provider.zai.models["GLM-6"] = {
      name: "My model", limit: { context: 42_000 }, modalities: { input: ["text", "image"] }
    };
    await writeFile(userConfigPath(env), JSON.stringify(config));
    await applyRefreshedModelsToConfig(catalogResult(env), env);
    const models = (await readConfig(env)).provider.zai.models;
    expect(models["glm-6"]).toBeUndefined();
    expect(models["GLM-6"]).toMatchObject({
      name: "My model", limit: { context: 42_000, output: 128_000 },
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: { enabled: true, defaultLevel: "max", levels: ["low", "high", "max"],
        providerOptionsByLevel: { max: { anthropic: { effort: "max" } } } }
    });
  });

  test("updates automatically owned metadata and is idempotent", async () => {
    const env = await configuredHome();
    const result = catalogResult(env);
    await applyRefreshedModelsToConfig(result, env);
    result.catalog.builtinModels[0]!.contextWindow = 2_000_000;
    await applyRefreshedModelsToConfig(result, env);
    expect((await readConfig(env)).provider.zai.models["glm-6"].limit.context).toBe(2_000_000);
    const before = await stat(userConfigPath(env));
    await applyRefreshedModelsToConfig(result, env);
    expect((await stat(userConfigPath(env))).mtimeMs).toBe(before.mtimeMs);
  });

  test("removes only unchanged auto-added retired models after an authoritative refresh", async () => {
    const env = await configuredHome();
    await applyRefreshedModelsToConfig(catalogResult(env, ["GLM-6", "GLM-7", "GLM-8", "GLM-9", "GLM-10"]), env);
    const config = await readConfig(env);
    config.provider.zai.models["glm-7"].name = "User customized";
    config.model.main = "zai/glm-8";
    config.model.lite = "zai/glm-10";
    await writeFile(userConfigPath(env), JSON.stringify(config));
    const next = catalogResult(env, ["GLM-11"]);
    await applyRefreshedModelsToConfig({ ...next, refreshed: false }, env, ["zai/glm-9"]);
    expect((await readConfig(env)).provider.zai.models["glm-6"]).toBeDefined();
    await applyRefreshedModelsToConfig({ ...next, catalog: {
      ...next.catalog, lastFetchedAt: new Date(Date.now() - MODEL_CATALOG_REFRESH_TTL_MS).toISOString()
    } }, env, ["zai/glm-9"]);
    expect((await readConfig(env)).provider.zai.models["glm-6"]).toBeDefined();
    await applyRefreshedModelsToConfig(next, env, ["zai/glm-9"]);
    const after = await readConfig(env);
    expect(after.provider.zai.models["glm-6"]).toBeUndefined();
    for (const id of ["glm-5.2", "glm-7", "glm-8", "glm-9", "glm-10", "glm-11"]) {
      expect(after.provider.zai.models[id]).toBeDefined();
    }
    expect(after.model).toEqual(config.model);
  });

  test("partial or empty provider responses cannot retire models", async () => {
    const env = await configuredHome();
    await applyRefreshedModelsToConfig(catalogResult(env), env);
    const before = await readFile(userConfigPath(env), "utf8");
    for (const ids of [[], ["GLM-7", "GLM-MISSING"]]) {
      const partial = catalogResult(env, ["GLM-7"]);
      partial.catalog.builtinProviders[0]!.models = ids;
      await applyRefreshedModelsToConfig(partial, env);
      expect(await readFile(userConfigPath(env), "utf8")).toBe(before);
    }
  });

  test("retains ownership across package upgrades but isolates different catalog origins", async () => {
    const env = await configuredHome();
    const first = catalogResult(env);
    await applyRefreshedModelsToConfig({ ...first, catalog: {
      ...first.catalog, endpoint: "https://zcode.z.ai/api/v1/client/configs?app_version=1&platform=darwin-arm64"
    } }, env);
    const second = catalogResult(env, ["GLM-7"]);
    await applyRefreshedModelsToConfig({ ...second, catalog: {
      ...second.catalog, endpoint: "https://zcode.z.ai/api/v1/client/configs?app_version=2&platform=darwin-arm64"
    } }, env);
    expect((await readConfig(env)).provider.zai.models["glm-6"]).toBeUndefined();
    const third = catalogResult(env, ["GLM-8"]);
    await applyRefreshedModelsToConfig({ ...third, catalog: {
      ...third.catalog, endpoint: "https://other.test/api/v1/client/configs?app_version=2"
    } }, env);
    expect((await readConfig(env)).provider.zai.models["glm-7"]).toBeDefined();
  });

  test("keeps models still advertised by the official regular provider catalog", async () => {
    const env = await configuredHome();
    await applyRefreshedModelsToConfig(catalogResult(env), env);
    const remote = await fetchRemoteModelCatalog({
      baseUrl: "https://zcode.z.ai", currentVersion: "3.11.2-21", env,
      fetcher: mockFetcher({ code: 0, data: {
        ...catalogResult(env, ["GLM-7"]).catalog,
        providers: [{ id: "z-ai", schema: "anthropic", baseUrl: "https://api.z.ai/api/anthropic",
          models: [{ modelId: "GLM-6", name: "GLM-6" }] }]
      } })
    });
    await applyRefreshedModelsToConfig({
      ...catalogResult(env),
      catalog: { lastFetchedAt: new Date().toISOString(), retirementSafe: remote.retirementSafe,
        builtinModels: remote.builtinModels!, builtinProviders: remote.builtinProviders! }
    }, env);
    const models = (await readConfig(env)).provider.zai.models;
    expect(models["glm-6"]).toBeDefined();
    expect(models["glm-7"]).toBeDefined();
  });

  test("missing catalog sections and invalid memberships never authorize retirement", async () => {
    const env = await configuredHome();
    await applyRefreshedModelsToConfig(catalogResult(env), env);
    const next = catalogResult(env, ["GLM-7"]);
    for (const data of [
      next.catalog,
      { ...next.catalog, providers: [], builtinProviders: [{ id: "builtin:zai-coding-plan", models: ["GLM-7", 42] }] },
      { ...next.catalog, providers: [{ id: "z-ai", models: [] }] }
    ]) {
      const remote = await fetchRemoteModelCatalog({
        baseUrl: "https://zcode.z.ai", currentVersion: "1", env, fetcher: mockFetcher({ code: 0, data })
      });
      expect(remote.retirementSafe).toBe(false);
      await applyRefreshedModelsToConfig({ ...next, catalog: {
        ...next.catalog, ...remote, builtinModels: remote.builtinModels!, builtinProviders: remote.builtinProviders!
      } }, env);
      expect((await readConfig(env)).provider.zai.models["glm-6"]).toBeDefined();
    }
  });
});

describe("non-blocking model discovery", () => {
  test("model selection never awaits a slow first-run fetch, then applies the downloaded catalog", async () => {
    const env = await configuredHome();
    const response = Promise.withResolvers<Response>();
    const requested = Promise.withResolvers<void>();
    const refresh = new ModelCatalogRefresh({
      baseUrl: "https://zcode.z.ai", currentVersion: "3.11.2-21", env,
      fetcher: async () => { requested.resolve(); return response.promise; }
    });
    try {
      refresh.start();
      await requested.promise;
      await refresh.apply();
      expect((await readConfig(env)).provider.zai.models["glm-6"]).toBeUndefined();
      response.resolve(new Response(JSON.stringify({ code: 0, data: catalogResult(env).catalog })));
      for (let tries = 0; tries < 100; tries++) {
        await Bun.sleep(5);
        await refresh.apply();
        if ((await readConfig(env)).provider.zai.models["glm-6"]) break;
      }
      expect((await readConfig(env)).provider.zai.models["glm-6"]).toBeDefined();
    } finally {
      refresh.stop();
      response.resolve(new Response("{}"));
    }
  });
});
