import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { providerConfigPath } from "./model-access.ts";
import { sharedDataBaseDir } from "./config-paths.ts";

type JsonRecord = Record<string, unknown>;
const bundledBuiltinPath = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "provider", "zcode-builtin.json");

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function modelIds(config: JsonRecord): Map<string, Set<string>> | undefined {
  if (config.schemaVersion !== 1) return undefined;
  const root = record(config.config);
  const providerConfigRules = record(root?.providerConfigRules);
  const providers = Array.isArray(providerConfigRules?.providerRules) ? providerConfigRules.providerRules : undefined;
  if (!providers) return undefined;

  const result = new Map<string, Set<string>>();
  for (const value of providers) {
    const provider = record(value);
    const providerId = typeof provider?.providerId === "string" ? provider.providerId : undefined;
    const providerConfig = record(provider?.config);
    if (!providerId || !providerConfig) continue;
    const ids = new Set<string>();
    if (Array.isArray(providerConfig.personalModelIds)) {
      for (const id of providerConfig.personalModelIds) if (typeof id === "string") ids.add(id);
    }
    if (Array.isArray(providerConfig.builtinModelIds)) {
      for (const id of providerConfig.builtinModelIds) if (typeof id === "string") ids.add(id);
    }
    result.set(providerId, ids);
  }

  const modelRules = record(root?.modelConfigRules);
  for (const key of ["providerModelRules", "manualProviderModelRules"]) {
    const rules = modelRules?.[key];
    if (!Array.isArray(rules)) continue;
    for (const value of rules) {
      const rule = record(value);
      if (typeof rule?.providerId !== "string" || typeof rule.modelId !== "string") continue;
      result.get(rule.providerId)?.add(rule.modelId);
    }
  }
  return result;
}

async function readCatalog(path: string, missingIsEmpty = false): Promise<Map<string, Set<string>> | undefined> {
  try {
    const config = record(JSON.parse(await readFile(path, "utf8")));
    return config ? modelIds(config) : undefined;
  } catch (error) {
    if (missingIsEmpty && (error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    return undefined;
  }
}

/**
 * Reject a CLI override before the interactive runtime starts when both local
 * registries are readable and conclusively show that the selection is absent.
 * If either registry is unavailable, defer to the runtime to avoid rejecting
 * models supplied by a remote or not-yet-materialized catalog.
 */
export async function invalidConfiguredPromptModel(
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  if (!model) return undefined;
  let personal: Map<string, Set<string>> | undefined;
  let builtin: Map<string, Set<string>> | undefined;
  try {
    const builtinOverride = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
    const builtinPath = builtinOverride
      || join(sharedDataBaseDir(env), ".zcode", "v2", "runtime", "provider", "bundled", "zcode-builtin.json");
    [personal, builtin] = await Promise.all([
      readCatalog(providerConfigPath(env), true),
      readCatalog(builtinPath).then(async (catalog) =>
        catalog ?? (builtinOverride ? undefined : await readCatalog(bundledBuiltinPath))
      )
    ]);
  } catch {
    return undefined;
  }
  if (!personal || !builtin) return undefined;

  const separator = model.indexOf("/");
  const providerId = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  const personalModels = personal.get(providerId);
  const builtinModels = builtin.get(providerId);
  if (!personalModels && !builtinModels) {
    return `Unknown model provider: ${providerId}`;
  }
  if (!personalModels?.has(modelId) && !builtinModels?.has(modelId)) {
    return `Unknown model: ${providerId}/${modelId}`;
  }
  return undefined;
}
