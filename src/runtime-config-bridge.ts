import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cliSettingsPath, legacyCliConfigPath, providerConfigPath, providerMigrationMarkerPath, readDesktopSettings } from "./config-paths.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Desktop preferences supply defaults; explicit CLI and project settings still win. */
export function mergeDesktopSettings(value: unknown, filePath: string, env: NodeJS.ProcessEnv = process.env): unknown {
  const settings = record(value);
  if (!settings || resolve(filePath) !== resolve(cliSettingsPath(env))) return value;
  const desktop = readDesktopSettings(env);
  const locale = desktop.localePreference;
  const memory = typeof desktop.memoryEnabled === "boolean" ? desktop.memoryEnabled : undefined;
  const memorySettings = { ...memory !== undefined ? { use: memory, write: memory } : {}, ...record(settings.memory) };
  const memoryFeature = typeof memorySettings.use === "boolean" && typeof memorySettings.write === "boolean"
    ? memorySettings.use || memorySettings.write : memory;
  return {
    ...settings,
    ui: { ...typeof locale === "string" ? { locale } : {}, ...record(settings.ui) },
    memory: memorySettings,
    features: { ...memoryFeature !== undefined ? { memory: memoryFeature } : {}, ...record(settings.features) }
  };
}

interface ProviderRule { providerId: string; config: unknown; [key: string]: unknown }
interface ModelRule { providerId: string; modelId: string; config: unknown }
interface ProviderMap {
  has(id: string): boolean;
  rules(): ProviderRule[];
  setRule(rule: ProviderRule): ProviderMap;
}
interface ModelRules {
  rules(): ModelRule[];
  getExactRule(provider: string, model: string): ModelRule | undefined;
  setExact(provider: string, model: string, config: unknown): ModelRules;
}
interface Snapshot {
  providers: ProviderMap;
  models: ModelRules;
  [key: string]: unknown;
}
interface Repository {
  read(): Promise<Snapshot>;
  update(change: (value: Snapshot) => Snapshot): Promise<Snapshot>;
  dispose(): void;
}

export function providerMigrationNeeded(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(legacyCliConfigPath(env)) && !existsSync(providerMigrationMarkerPath(env));
}

/** Uses the upstream parser and file-locked repository, rather than editing shared JSON. */
export async function migrateLegacyProviders(options: {
  Repository: new (options: { filePath: string; pollingIntervalMs: false; onRecovery: (event: unknown) => void }) => Repository;
  importLegacy: (options: { input: unknown }) => Snapshot;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = options.env ?? process.env;
  if (!providerMigrationNeeded(env)) return;
  let legacy: Record<string, unknown> | undefined;
  try {
    legacy = record(JSON.parse(await readFile(legacyCliConfigPath(env), "utf8")));
  } catch {
    throw new Error("Legacy provider config could not be read; no provider settings were changed.");
  }
  if (!legacy) throw new Error("Legacy provider config must be an object.");
  const imported: string[] = [], skipped: string[] = [];
  const candidates: Snapshot[] = [];
  for (const [id, raw] of Object.entries(record(legacy.provider) ?? {})) {
    const provider = record(raw), key = record(provider?.options)?.apiKey;
    const builtinApi = id === "builtin:zai" || id === "builtin:bigmodel";
    // Match Desktop's namespace/source rules. Encrypted/account secrets belong
    // to the native account service, not a personal-provider migration.
    if (!provider || id.startsWith("account:") || id.startsWith("builtin:") && !builtinApi
      || provider.source !== undefined && provider.source !== "custom" && !builtinApi
      || typeof key === "string" && key.startsWith("enc:")
      || (builtinApi || id.startsWith("default-")) && !(typeof key === "string" && key.trim())) {
      skipped.push(id);
      continue;
    }
    try {
      // Convert one provider at a time: an unsupported local provider must not
      // prevent the remaining providers from being migrated.
      const candidate = options.importLegacy({ input: { provider: { [id]: provider } } });
      let providers = candidate.providers;
      for (const rule of candidate.providers.rules()) {
        if (typeof provider.enabled === "boolean") providers = providers.setRule({ ...rule, enabled: provider.enabled });
      }
      candidates.push({ ...candidate, providers });
    } catch {
      skipped.push(id);
    }
  }
  let recovery = false;
  const repository = new options.Repository({ filePath: providerConfigPath(env), pollingIntervalMs: false, onRecovery: () => { recovery = true; } });
  try {
    const current = await repository.read();
    if (recovery) throw new Error("The shared provider config needs recovery; it was left unchanged.");
    if (candidates.some(candidate => candidate.providers.rules().some(rule => !current.providers.has(rule.providerId)))) {
      await repository.update(snapshot => {
        let { providers, models } = snapshot;
        for (const candidate of candidates) for (const rule of candidate.providers.rules()) {
          if (providers.has(rule.providerId)) continue;
          providers = providers.setRule(rule);
          for (const model of candidate.models.rules()) {
            if (model.providerId === rule.providerId && !models.getExactRule(model.providerId, model.modelId)) {
              models = models.setExact(model.providerId, model.modelId, model.config);
            }
          }
          imported.push(rule.providerId);
        }
        // Desktop's importer does not select a default model. Preserve that
        // behavior and any existing order, default selection and overrides.
        return { ...snapshot, providers, models };
      });
    }
  } finally {
    repository.dispose();
  }
  const marker = providerMigrationMarkerPath(env), temporary = `${marker}.${process.pid}.tmp`;
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, imported, skipped, completedAt: new Date().toISOString() }), { mode: 0o600 });
    await rename(temporary, marker);
  } finally {
    await rm(temporary, { force: true });
  }
}
