import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptOverrides } from "./prompt-model.ts";

const environmentProviderId = "cli-env";
const apiTypes = ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const;
type ApiType = typeof apiTypes[number];

export interface PromptEnvironment {
  model?: string;
  effort?: string;
  provider?: { baseUrl: string; apiKey: string; modelId: string; apiType: ApiType };
}

export function resolvePromptEnvironment(
  overrides: PromptOverrides, env: NodeJS.ProcessEnv = process.env
): PromptEnvironment {
  if (!overrides.headless) return { model: overrides.model, effort: overrides.effort };
  const model = overrides.model ?? (env.ZCODE_MODEL?.trim() || undefined);
  const effort = overrides.effort ?? (env.ZCODE_EFFORT?.trim() || undefined);
  if (effort && (!/^[a-z][a-z0-9_-]*$/iu.test(effort))) {
    throw new Error("ZCODE_EFFORT must be a single reasoning effort level.");
  }
  const baseUrl = env.ZCODE_MODEL_BASE_URL?.trim();
  const apiKey = env.ZCODE_API_KEY?.trim();
  const apiType = env.ZCODE_API_TYPE?.trim() || "openai-chat-completions";
  const customProvider = Boolean(baseUrl || apiKey || env.ZCODE_API_TYPE?.trim());
  if (!customProvider) {
    if (model && !/^[^/\s]+\/\S+$/u.test(model)) {
      throw new Error("ZCODE_MODEL must be a provider/model ID unless ZCODE_MODEL_BASE_URL is configured.");
    }
    return { model, effort };
  }
  if (!baseUrl || !apiKey || !model) {
    throw new Error("Custom model access requires ZCODE_MODEL_BASE_URL, ZCODE_API_KEY and ZCODE_MODEL (or --model).");
  }
  let url: URL;
  try { url = new URL(baseUrl); } catch {
    throw new Error("ZCODE_MODEL_BASE_URL must be an absolute HTTP(S) URL.");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("ZCODE_MODEL_BASE_URL must be an HTTP(S) URL without credentials, query or fragment.");
  }
  if (!apiTypes.includes(apiType as ApiType)) {
    throw new Error(`ZCODE_API_TYPE must be one of: ${apiTypes.join(", ")}.`);
  }
  if (/\s/u.test(model) || model.startsWith("-")) throw new Error("Custom model ID must not contain whitespace or start with '-'.");
  if (/[\r\n]/u.test(apiKey)) throw new Error("ZCODE_API_KEY must not contain line breaks.");
  return {
    model: `${environmentProviderId}/${model}`, effort,
    provider: { baseUrl, apiKey, modelId: model, apiType: apiType as ApiType }
  };
}

export async function preparePromptEnvironment(selection: PromptEnvironment): Promise<{
  env: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}> {
  const env: NodeJS.ProcessEnv = {
    ...(selection.model ? { ZCODE_CLI_PROMPT_MODEL: selection.model } : {}),
    ...(selection.effort ? { ZCODE_CLI_PROMPT_EFFORT: selection.effort } : {})
  };
  if (!selection.provider) return { env, dispose: async () => {} };
  const { baseUrl, apiKey, modelId, apiType } = selection.provider;
  const effort = selection.effort?.toLowerCase();
  const explicitEffort = effort && effort !== "auto" ? effort : undefined;
  const reasoningMap = !explicitEffort ? "{}" : apiType === "openai-chat-completions"
    ? '{"reasoning_effort": reasoningLevel}'
    : apiType === "openai-responses" ? '{"reasoning": {"effort": reasoningLevel}}'
    : 'reasoningLevel == "disabled" || reasoningLevel == "none" ? {"thinking": {"type": "disabled"}} : {"thinking": {"type": "adaptive"}, "output_config": {"effort": reasoningLevel}}';
  const providerConfig = {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [{
        providerId: environmentProviderId, providerName: "Environment model", enabled: true,
        config: {
          group: "standard-personal", access: { type: "api-key", apiKey },
          api: { type: apiType, baseUrl }, personalModelIds: [modelId]
        }
      }] },
      modelConfigRules: {
        providerModelRules: [{ providerId: environmentProviderId, modelId, config: {
          enabled: true, optionSpecs: { reasoningLevel: {
            values: [explicitEffort ?? "default"], map: reasoningMap
          } }
        } }],
        manualProviderModelRules: []
      },
      defaultModelSelection: { providerId: environmentProviderId, modelId }
    }
  };
  const directory = await mkdtemp(join(tmpdir(), "zcode-prompt-provider-"));
  const dispose = async () => { await rm(directory, { recursive: true, force: true }); };
  try {
    const path = join(directory, "provider_config.json");
    await writeFile(path, JSON.stringify(providerConfig), { mode: 0o600 });
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path;
    return { env, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
