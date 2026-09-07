import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureUserConfig, userConfigPath } from "../src/model-access.ts";
import { applyRefreshedModelsToConfig, modelCatalogCachePath, resolveModelCatalogEndpoint } from "../src/model-catalog-refresh.ts";
import { readDistributionVersion } from "../src/launcher.ts";

function plainText(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

test.skipIf(process.platform === "win32").each([false, true])("native TUI starts before discovery and reloads models (first install: %p)", async (firstInstall) => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node.js is required for runtime integration tests.");
  const home = await mkdtemp(join(tmpdir(), "zcode-catalog-tui-"));
  const env = { HOME: home, USERPROFILE: home };
  const gate = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/api/v1/client/configs") return new Response("", { status: 404 });
      requested.resolve();
      await gate.promise;
      return Response.json({ code: 0, data: {
        providers: [],
        builtinModels: [{ modelId: "GLM-7", name: "GLM-7", contextWindow: 1_000_000, maxCompletionTokens: 128_000 }],
        builtinProviders: [{ id: "builtin:zai-coding-plan", schema: "anthropic", models: ["GLM-7"] }]
      } });
    }
  });
  const baseUrl = server.url.origin;
  const endpoint = resolveModelCatalogEndpoint(baseUrl, { ZCODE_APP_CLI_VERSION: readDistributionVersion() });
  await ensureUserConfig(env);
  const config = JSON.parse(await readFile(userConfigPath(env), "utf8"));
  config.provider.zai.options.apiKey = "fixture-key-not-real";
  config.ui.locale = "en-US";
  config.plugins.enabled = false;
  config.memory.use = false;
  config.memory.write = false;
  await writeFile(userConfigPath(env), JSON.stringify(config));
  await applyRefreshedModelsToConfig({ cachePath: modelCatalogCachePath(env), refreshed: true, catalog: {
    endpoint, lastFetchedAt: new Date().toISOString(),
    builtinModels: [{ modelId: "GLM-6", name: "GLM-6" }],
    builtinProviders: [{ id: "builtin:zai-coding-plan", models: ["GLM-6"] }]
  } }, env);
  if (firstInstall) await rm(join(home, ".zcode", "cli"), { recursive: true, force: true });

  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 110, rows: 36, name: "xterm-256color",
    data(_terminal, data) { output += decoder.decode(data, { stream: true }); }
  });
  const child = Bun.spawn([node, join(import.meta.dir, "..", "bin", "zcode.js")], {
    cwd: home, terminal,
    env: { ...process.env, ...env, TERM: "xterm-256color", CI: "0",
      ZCODE_BASE_URL: baseUrl, ZCODE_DISABLE_MODEL_CATALOG_REFRESH: "0", ZCODE_DISABLE_UPDATE_CHECK: "1",
      ZCODE_TUI_MODE: "regular", ZCODE_NODE: node }
  });
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  async function waitFor(pattern: RegExp, offset = 0) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && child.exitCode === null) {
      if (pattern.test(plainText(output.slice(offset)))) return;
      await Bun.sleep(20);
    }
    throw new Error(`Missing ${pattern}: ${plainText(output).slice(-4000)}`);
  }
  try {
    if (firstInstall) {
      await waitFor(/Welcome to ZCode CLI/);
      await requested.promise;
      const initial = JSON.parse(await readFile(userConfigPath(env), "utf8"));
      expect(initial.model.main).toBe("zai/glm-5.2");
      expect(initial.provider.zai.options.apiKey).toBeUndefined();
      return;
    }
    await waitFor(/zai\/glm-5\.2/);
    await requested.promise;
    const firstPicker = output.length;
    terminal.write("/model\r");
    await waitFor(/Select model/, firstPicker);
    expect(plainText(output.slice(firstPicker))).toContain("zai/glm-6");
    expect(plainText(output.slice(firstPicker))).not.toContain("zai/glm-7");
    terminal.write("\x1b");
    await Bun.sleep(50);
    gate.resolve();
    const cacheExists = () => stat(modelCatalogCachePath(env)).then(() => true, () => false);
    for (let i = 0; i < 100 && !await cacheExists(); i++) await Bun.sleep(20);
    expect(await cacheExists()).toBe(true);
    await Bun.sleep(30);
    const nextPicker = output.length;
    terminal.write("/model\r");
    await waitFor(/Select model/, nextPicker);
    const currentPicker = plainText(output.slice(nextPicker));
    expect(currentPicker).toContain("zai/glm-7");
    expect(currentPicker).not.toContain("zai/glm-6");
    terminal.write("\x1b");
    await Bun.sleep(50);
    const switched = output.length;
    terminal.write("/model zai/glm-7\r");
    await waitFor(/Session model now: zai\/glm-7/, switched);
    const saved = JSON.parse(await readFile(userConfigPath(env), "utf8"));
    expect(saved.model).toEqual(config.model);
    expect(saved.provider.zai.models["glm-7"]).toBeDefined();
    expect(saved.provider.zai.models["glm-6"]).toBeUndefined();
  } finally {
    gate.resolve();
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    clearTimeout(killTimer);
    terminal.close();
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 25_000);
