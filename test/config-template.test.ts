import { expect, test } from "bun:test";
import { join } from "node:path";

interface ConfigTemplate {
  modelStream: {
    idleTimeoutMs: number;
  };
  subagents: {
    autoBackgroundMs: number;
  };
  ui: {
    theme: string;
    copyOnSelect: boolean;
    notifications: {
      method: string;
      condition: string;
    };
  };
}

test("general config template keeps runtime settings separate from providers", async () => {
  const file = Bun.file(join(import.meta.dir, "..", "setting.example.json"));
  const config = (await file.json()) as ConfigTemplate;
  expect(config.modelStream.idleTimeoutMs).toBe(60_000);
  expect(config.subagents.autoBackgroundMs).toBe(1_000);
  expect(config.ui.theme).toBe("auto");
  expect(config.ui.copyOnSelect).toBe(true);
  expect(config.ui.notifications).toEqual({ method: "auto", condition: "unfocused" });
  expect(config).not.toHaveProperty("provider");
  expect(config).not.toHaveProperty("model");
});

test("provider template uses the native registry schema", async () => {
  const config = await Bun.file(join(import.meta.dir, "..", "provider.example.json")).json();
  const selection = config.config.defaultModelSelection;
  const provider = config.config.providerConfigRules.providerRules.find((rule: { providerId: string }) => rule.providerId === selection.providerId);
  expect(config.schemaVersion).toBe(1);
  expect(provider.config.personalModelIds).toContain(selection.modelId);
  expect(provider.config.access.apiKey).toBe("");
  const rules = config.config.modelConfigRules;
  const automatic = rules.providerModelRules.find((rule: { modelId: string }) => rule.modelId === selection.modelId);
  expect(automatic.config).toEqual({ enabled: true });
  expect(rules.providerModelRules.find((rule: { modelId: string }) => rule.modelId === "overrides-reference").config.enabled).toBe(false);
  expect(rules.manualProviderModelRules.find((rule: { modelId: string }) => rule.modelId === "manual-reference").config.enabled).toBe(false);
  expect(config.config.providerOrder).toContain(selection.providerId);
});
