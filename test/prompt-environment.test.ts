import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { extractPromptOverrides } from "../src/prompt-model.ts";
import { preparePromptEnvironment, resolvePromptEnvironment } from "../src/prompt-environment.ts";

const customEnvironment = {
  ZCODE_MODEL_BASE_URL: "https://gateway.example.test/v1",
  ZCODE_API_KEY: "fixture-secret",
  ZCODE_MODEL: "organization/custom-model",
  ZCODE_EFFORT: "high"
};

function resolve(args: string[], env: NodeJS.ProcessEnv = {}) {
  return resolvePromptEnvironment(extractPromptOverrides(args, {}, Boolean(env.ZCODE_MODEL_BASE_URL?.trim())), env);
}

test("uses environment model and effort only for headless prompts", () => {
  expect(resolve(["-p", "task"], { ZCODE_MODEL: "custom/model", ZCODE_EFFORT: "high" }))
    .toEqual({ model: "custom/model", effort: "high" });
  for (const args of [[], ["tui"], ["app-server"], ["doctor"], ["--help"], ["-p", "task", "-h"], ["-p", "task", "--help"]]) {
    expect(resolve(args, { ...customEnvironment, ZCODE_API_TYPE: "invalid" }).provider).toBeUndefined();
    expect(resolve(args, customEnvironment).model).toBeUndefined();
  }
});

test("explicit arguments override environment model and effort", () => {
  const selection = resolve(["-p", "task", "--model", "different/model", "--effort", "auto"], customEnvironment);
  expect(selection.model).toBe("cli-env/different/model");
  expect(selection.provider?.modelId).toBe("different/model");
  expect(selection.effort).toBe("auto");
  expect(resolve(["-p", "task", "--model=custom/other", "--effort=low"], {
    ZCODE_MODEL: "invalid model", ZCODE_EFFORT: "invalid effort"
  })).toEqual({ model: "custom/other", effort: "low" });
  expect(resolve(["-p", "task", "--model", "bare-model"], customEnvironment).provider?.modelId).toBe("bare-model");
});

test("leaves blank environment settings unset and preserves the account base URL", () => {
  expect(resolve(["-p", "task"], { ZCODE_MODEL: " ", ZCODE_EFFORT: " ", ZCODE_API_KEY: " ", ZCODE_API_TYPE: " " }))
    .toEqual({ model: undefined, effort: undefined });
  expect(resolve(["-p", "task"], { ZCODE_BASE_URL: "https://account.example.test" }).provider).toBeUndefined();
  expect(resolve(["-p", "task"], { ...customEnvironment, ZCODE_BASE_URL: "https://account.example.test" }).provider?.baseUrl)
    .toBe(customEnvironment.ZCODE_MODEL_BASE_URL);
});

test("rejects partial or invalid configuration without including credentials in errors", () => {
  for (const env of [
    { ZCODE_API_KEY: "secret" }, { ZCODE_MODEL_BASE_URL: "https://example.test" },
    { ...customEnvironment, ZCODE_MODEL: "" }, { ...customEnvironment, ZCODE_API_KEY: "" },
    { ...customEnvironment, ZCODE_API_TYPE: "invalid" }, { ...customEnvironment, ZCODE_MODEL: "bad model" },
    { ...customEnvironment, ZCODE_API_KEY: "secret\nheader" }, { ZCODE_MODEL: "bare-model" },
    { ZCODE_EFFORT: "high effort" }, { ...customEnvironment, ZCODE_EFFORT: "--high" }
  ]) expect(() => resolve(["-p", "task"], env)).toThrow();
  for (const baseUrl of ["invalid", "file:///secret", "https://user:secret@example.test", "https://example.test?key=secret", "https://example.test/#secret"]) {
    try {
      resolve(["-p", "task"], { ...customEnvironment, ZCODE_MODEL_BASE_URL: baseUrl });
      throw new Error("accepted invalid URL");
    } catch (error) {
      expect(String(error)).toContain("ZCODE_MODEL_BASE_URL");
      expect(String(error)).not.toContain("secret");
    }
  }
});

test.each([
  ["openai-chat-completions", '{"reasoning_effort": reasoningLevel}'],
  ["openai-responses", '{"reasoning": {"effort": reasoningLevel}}'],
  ["anthropic-messages", 'reasoningLevel == "disabled" || reasoningLevel == "none" ? {"thinking": {"type": "disabled"}} : {"thinking": {"type": "adaptive"}, "output_config": {"effort": reasoningLevel}}']
])("creates a private disposable provider for %s", async (apiType, mapping) => {
  const selection = resolve(["-p", "task"], { ...customEnvironment, ZCODE_API_TYPE: apiType });
  const prepared = await preparePromptEnvironment(selection);
  const path = prepared.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE!;
  try {
    const config = JSON.parse(await readFile(path, "utf8")).config;
    const provider = config.providerConfigRules.providerRules[0];
    expect(provider.providerId).toBe("cli-env");
    expect(provider.config.api).toEqual({ type: apiType, baseUrl: customEnvironment.ZCODE_MODEL_BASE_URL });
    expect(provider.config.access).toEqual({ type: "api-key", apiKey: "fixture-secret" });
    expect(provider.config.personalModelIds).toEqual(["organization/custom-model"]);
    expect(config.modelConfigRules.providerModelRules[0].config.optionSpecs.reasoningLevel)
      .toEqual({ values: ["high"], map: mapping });
    expect(prepared.env.ZCODE_CLI_PROMPT_MODEL).toBe("cli-env/organization/custom-model");
    expect(prepared.env.ZCODE_CLI_PROMPT_EFFORT).toBe("high");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally { await prepared.dispose(); }
  expect(await Bun.file(path).exists()).toBe(false);
});

test.each([undefined, "auto"])("does not send reasoning parameters when effort is %s", async effort => {
  const selection = resolve(["-p", "task"], { ...customEnvironment, ZCODE_EFFORT: effort });
  const prepared = await preparePromptEnvironment(selection);
  try {
    const config = JSON.parse(await readFile(prepared.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE!, "utf8"));
    expect(config.config.modelConfigRules.providerModelRules[0].config.optionSpecs.reasoningLevel)
      .toEqual({ values: ["default"], map: "{}" });
  } finally { await prepared.dispose(); }
});

test("concurrent runs use independent configuration files", async () => {
  const selection = resolve(["-p", "task"], customEnvironment);
  const first = await preparePromptEnvironment(selection);
  const second = await preparePromptEnvironment(selection);
  try {
    expect(first.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).not.toBe(second.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE);
    await first.dispose();
    expect(await Bun.file(second.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE!).exists()).toBe(true);
  } finally { await Promise.all([first.dispose(), second.dispose()]); }
});

test("existing CLI argument validation remains strict outside custom endpoint mode", () => {
  for (const args of [
    ["--model", "custom/model"], ["-p", "task", "--model", "bare-model"],
    ["-p", "task", "--model", "one/model", "--model", "two/model"],
    ["-p", "task", "--effort", "high", "--effort", "low"], ["-p", "task", "--effort", "bad level"]
  ]) expect(() => resolve(args)).toThrow();
  expect(resolve(["-p", "task", "--effort", "low"], { ZCODE_MODEL: "saved/model" }))
    .toEqual({ model: "saved/model", effort: "low" });
});
