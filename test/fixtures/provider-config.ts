import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { providerConfigPath } from "../../src/model-access.ts";

export function providerFixture(options: {
  providerId?: string; modelId?: string; models?: string[]; apiKey?: string;
  baseUrl?: string; apiType?: string;
} = {}) {
  const providerId = options.providerId ?? "custom", modelId = options.modelId ?? "fixture-model";
  // Keep runtime fixtures minimal; the public example also contains disabled
  // reference models and must not supply unrelated overrides to every test.
  return { schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [{ providerId, providerName: "Custom provider", config: {
      group: "standard-personal", access: { type: "api-key", apiKey: options.apiKey },
      api: { type: options.apiType ?? "openai-chat-completions", baseUrl: options.baseUrl ?? "https://example.test/v1" },
      personalModelIds: options.models ?? [modelId]
    } }] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    defaultModelSelection: { providerId, modelId }
  } };
}

export async function writeProviderFixture(env: NodeJS.ProcessEnv, options: Parameters<typeof providerFixture>[0] = {}) {
  const config = providerFixture(options), path = providerConfigPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config));
  return { config, path };
}
