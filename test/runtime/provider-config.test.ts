import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

/** Exercise the bundled registry without contacting an account service or changing user files. */
async function probeRegistry(personal: unknown, body: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-provider-config-"));
  try {
    const personalPath = join(home, "provider_config.json"), builtinPath = join(home, "builtin.json");
    await writeFile(personalPath, JSON.stringify(personal));
    await writeFile(builtinPath, await readFile(join(root, "vendor/provider/zcode-builtin.json")));
    const script = `
      const fs = require("node:fs"), Module = require("node:module"), path = require("node:path");
      const file = ${JSON.stringify(join(root, "vendor/zcode.cjs"))};
      let source = fs.readFileSync(file, "utf8");
      const symbol = /[A-Za-z_$][\\w$]*\\(([A-Za-z_$][\\w$]*),"startProcessProviderRegistryRuntime"\\)/u.exec(source);
      if (!symbol) throw new Error("Missing native registry bootstrap");
      const init = [...source.slice(0, symbol.index).matchAll(/([A-Za-z_$][\\w$]*)=[A-Za-z_$][\\w$]*\\(\\(\\)=>\\{/gu)].at(-1)?.[1];
      const main = /async function [A-Za-z_$][\\w$]*\\(\\)\\{let [A-Za-z_$][\\w$]*=process\\.argv\\.slice\\(2\\);/u.exec(source);
      if (!init || !main) throw new Error("Missing native registry test entry");
      const body = ${JSON.stringify(body)};
      source = source.replace(main[0], main[0] + init + "();await(async(startRegistry)=>{" + body + "})(" + symbol[1] + ");return;");
      const runtime = new Module(file, module);
      runtime.filename = file;
      runtime.paths = Module._nodeModulePaths(path.dirname(file));
      runtime._compile(source, file);
    `;
    const child = Bun.spawn([Bun.which("node")!, "--eval", script], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: home,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath,
        ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "" },
      stdout: "pipe", stderr: "pipe"
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr || stdout).toBe(0);
    expect(stdout).toContain("PROVIDER_CONFIG_OK");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("the complete provider example passes the current native schema", async () => {
  const example = await Bun.file(join(root, "provider.example.json")).json();
  await probeRegistry(example, `
    const assert = require("node:assert/strict");
    const host = await startRegistry(process.env, { standalone: {} });
    try {
      const snapshot = await host.runtime.personalRepository.read();
      assert.equal(snapshot.providers.has("custom"), true);
      assert.equal(snapshot.providers.has("coding-plan-example"), true);
      const smart = snapshot.models.getExactRule("custom", "overrides-reference").config.toJSON();
      assert.deepEqual(Object.keys(smart.properties.inputFormat).sort(), ["supportsAudio", "supportsImage", "supportsPdf", "supportsText", "supportsVideo"]);
      assert.equal(smart.optionSpecs.maxOutputTokens.max, 32768);
      assert.equal(typeof smart.optionSpecs.reasoningLevel.map, "string");
      const manual = snapshot.models.getExactRule("custom", "manual-reference");
      assert.equal(manual.type, "manual-provider-model");
      assert.equal(manual.config.toJSON().properties.supportsMidConversationSystem, false);
      assert.equal(snapshot.defaultModelSelection.options.reasoningLevel, "disabled");
      console.log("PROVIDER_CONFIG_OK");
    } finally { host.dispose(); }
  `);
}, 15_000);

test("upstream catalog refresh updates all inherited capabilities and keeps user overrides", async () => {
  const example = await Bun.file(join(root, "provider.example.json")).json();
  example.config.providerConfigRules.providerRules[0].config.access.apiKey = "fixture-key";
  example.config.providerConfigRules.providerRules[0].config.personalModelIds.push("user-overridden-model");
  example.config.modelConfigRules.providerModelRules.push({ providerId: "custom", modelId: "user-overridden-model",
    config: { properties: { inputFormat: { supportsImage: false } } } });
  example.config.modelConfigRules.manualProviderModelRules[0].config.enabled = true;
  await probeRegistry(example, `
    const assert = require("node:assert/strict"), fs = require("node:fs/promises");
    const host = await startRegistry(process.env, { standalone: {} });
    try {
      const registry = host.runtime.registryService;
      const before = registry.getModel("custom", "your-model-id").config;
      assert.equal(before.properties.inputFormat.supportsImage, false);
      const personalBefore = await fs.readFile(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8");
      const builtin = JSON.parse(await fs.readFile(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, "utf8"));
      builtin.revision += 1;
      const properties = {
        contextWindow: 1000000, requiresMfjsToolSchema: true, supportsToolCall: true,
        supportsJsonSchemaOutput: true, supportsNativeWebSearch: true, supportsMidConversationSystem: true,
        inputFormat: { supportsText: true, supportsImage: true, supportsVideo: true, supportsAudio: true, supportsPdf: true },
        outputFormat: { supportsText: true }
      };
      const optionSpecs = {
        reasoningLevel: { values: ["low", "high", "max"], map: '{"reasoning_effort": reasoningLevel}' },
        maxOutputTokens: { max: 128000, map: '{"max_completion_tokens": maxOutputTokens}' }
      };
      builtin.config.modelConfigRules.providerSiteRules.push({
        modelMatch: "your-model-id|user-overridden-model|manual-reference",
        apiTypeMatch: "openai-chat-completions", baseUrlMatch: "https://api[.]example[.]com/v1",
        config: { properties, optionSpecs }
      });
      await fs.writeFile(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, JSON.stringify(builtin));
      // The real CLI updates its account snapshot to the same catalog revision
      // before publishing the new registry view.
      await host.accountSource.refresh("test-upstream-model-refresh");
      await registry.refresh("test-upstream-model-refresh");
      const updated = registry.getModel("custom", "your-model-id").config.toJSON();
      assert.deepEqual(updated.properties, properties);
      assert.deepEqual(updated.optionSpecs, optionSpecs);
      const overridden = registry.getModel("custom", "user-overridden-model").config.toJSON();
      assert.equal(overridden.properties.inputFormat.supportsImage, false);
      assert.equal(overridden.properties.inputFormat.supportsVideo, true);
      assert.equal(overridden.optionSpecs.maxOutputTokens.max, 128000);
      const manual = registry.getModel("custom", "manual-reference").config.toJSON();
      assert.equal(manual.properties.inputFormat.supportsVideo, false);
      assert.equal(manual.properties.contextWindow, 200000);
      assert.equal(manual.optionSpecs.maxOutputTokens.max, 32768);
      assert.equal(await fs.readFile(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8"), personalBefore);
      console.log("PROVIDER_CONFIG_OK");
    } finally { host.dispose(); }
  `);
}, 15_000);
