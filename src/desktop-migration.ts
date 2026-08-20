import { copyFile, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";

import { updateUserConfig, userConfigPath, type UserConfigRecord } from "./model-access.ts";

const desktopConfigDirectory = "v2";

const knownFamilies = ["zai", "bigmodel"] as const;
export type DesktopFamily = (typeof knownFamilies)[number];

interface DesktopProviderConfig {
  models?: Record<string, unknown>;
  options?: {
    apiKey?: unknown;
  };
}

interface DesktopUserConfig {
  provider?: Record<string, DesktopProviderConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function desktopProviderFamilyScore(providerId: string, family: DesktopFamily): number | undefined {
  if (providerId === `builtin:${family}-coding-plan`) return 4;
  if (providerId === family || providerId === `builtin:${family}`) return 3;
  if (providerId.endsWith(`:${family}`)) return 2;
  if (providerId.startsWith(`builtin:${family}-`)) return 1;
  return undefined;
}

function desktopHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, fallbackHome: string): string {
  const configured = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim();
  return configured || fallbackHome;
}

export function desktopConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir()
): string {
  const path = platform === "win32" ? win32 : posix;
  return path.join(desktopHome(env, platform, fallbackHome), ".zcode", desktopConfigDirectory, "config.json");
}

function desktopSettingPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fallbackHome: string
): string {
  const path = platform === "win32" ? win32 : posix;
  return path.join(
    desktopHome(env, platform, fallbackHome),
    ".zcode",
    desktopConfigDirectory,
    "setting.json"
  );
}

export interface DesktopModelMigration {
  id: string;
  name: string;
}

export interface DesktopFamilyMigration {
  family: DesktopFamily;
  providerName: string;
  baseURL?: string;
  models: DesktopModelMigration[];
}

export interface DesktopMigrationPlan {
  families: DesktopFamilyMigration[];
  defaultFamily?: DesktopFamily;
}

export interface DesktopInstallation {
  configPath: string;
  plan: DesktopMigrationPlan;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const existing = await stat(path);
    return existing.isFile();
  } catch {
    return false;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error("the root value must be a JSON object");
  return value;
}

function desktopModels(provider: DesktopProviderConfig): DesktopModelMigration[] {
  const models: DesktopModelMigration[] = [];
  for (const [id, raw] of Object.entries(provider.models ?? {})) {
    if (typeof id !== "string" || id.length === 0) continue;
    const detail = isRecord(raw) && typeof raw.name === "string" && raw.name.length > 0
      ? raw.name
      : id;
    models.push({ id, name: detail });
  }
  return models;
}

function readSelectedFamily(setting: Record<string, unknown> | undefined): DesktopFamily | undefined {
  if (!setting) return undefined;
  const selected = setting.modelProviderFamilySelectedKeys;
  if (!isRecord(selected)) return undefined;
  const domain = setting.providerFamilyDomain;
  if (typeof domain === "string" && (knownFamilies as readonly string[]).includes(domain)) {
    return domain as DesktopFamily;
  }
  for (const family of knownFamilies) {
    const value = selected[family];
    if (typeof value === "string" && value.length > 0) return family;
  }
  return undefined;
}

function baseURLFromOptions(options: unknown): string | undefined {
  if (!isRecord(options)) return undefined;
  const baseURL = options.baseURL;
  return typeof baseURL === "string" && baseURL.trim().length > 0 ? baseURL.trim() : undefined;
}

function buildMigrationPlan(
  desktopConfig: DesktopUserConfig,
  setting: Record<string, unknown> | undefined
): DesktopMigrationPlan {
  const providers = desktopConfig.provider ?? {};
  const families = new Map<DesktopFamily, { score: number; plan: DesktopFamilyMigration }>();
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) continue;
    let bestFamily: DesktopFamily | undefined;
    let bestScore = 0;
    for (const family of knownFamilies) {
      const score = desktopProviderFamilyScore(providerId, family);
      if (score !== undefined && score > bestScore) {
        bestFamily = family;
        bestScore = score;
      }
    }
    if (!bestFamily) continue;
    const models = desktopModels(provider);
    if (models.length === 0) continue;
    const existing = families.get(bestFamily);
    if (existing && existing.score >= bestScore) continue;

    const name = typeof provider.name === "string" && provider.name.length > 0
      ? provider.name
      : `${bestFamily} coding plan`;
    families.set(bestFamily, {
      score: bestScore,
      plan: {
        family: bestFamily,
        providerName: name,
        models,
        baseURL: baseURLFromOptions(provider.options)
      }
    });
  }

  const ordered: DesktopFamilyMigration[] = [];
  for (const family of knownFamilies) {
    const entry = families.get(family);
    if (entry) ordered.push(entry.plan);
  }
  return { families: ordered, defaultFamily: readSelectedFamily(setting) };
}

export async function detectDesktopInstallation(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir()
): Promise<DesktopInstallation | null> {
  const configPath = desktopConfigPath(env, platform, fallbackHome);
  if (!await fileExists(configPath)) return null;
  let desktopConfig: DesktopUserConfig;
  let setting: Record<string, unknown> | undefined;
  try {
    desktopConfig = await readJsonObject(configPath) as DesktopUserConfig;
  } catch {
    return null;
  }
  const settingPath = desktopSettingPath(env, platform, fallbackHome);
  if (await fileExists(settingPath)) {
    try {
      setting = await readJsonObject(settingPath);
    } catch {
      setting = undefined;
    }
  }
  const plan = buildMigrationPlan(desktopConfig, setting);
  if (plan.families.length === 0) return null;
  return { configPath, plan };
}

export interface MigrationApplyResult {
  configPath: string;
  backupPath: string;
}

function mergeModels(
  current: Record<string, unknown> | undefined,
  migrated: DesktopModelMigration[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const model of migrated) {
    const existing = isRecord(merged[model.id]) ? merged[model.id] : undefined;
    merged[model.id] = isRecord(existing)
      ? { ...existing, name: model.name }
      : { name: model.name };
  }
  return merged;
}

function normalizeModelId(id: string): string {
  return id.trim().toLowerCase();
}

function modelIdInCandidates(
  candidateIds: string[],
  preferredId: string | undefined
): string | undefined {
  if (!preferredId) return undefined;
  const normalized = preferredId.trim();
  if (normalized.length === 0) return undefined;
  if (candidateIds.includes(normalized)) return normalized;
  const preferredKey = normalizeModelId(normalized);
  return candidateIds.find((id) => normalizeModelId(id) === preferredKey);
}

function preferredOrFirstModel(
  candidateIds: string[],
  preferredId: string | undefined,
  fallbackIds: string[]
): string {
  const preferred = modelIdInCandidates(candidateIds, preferredId);
  if (preferred) return preferred;
  for (const fallbackId of fallbackIds) {
    const fallback = modelIdInCandidates(candidateIds, fallbackId);
    if (fallback) return fallback;
  }
  return candidateIds[0]!;
}

function selectMainModel(
  family: DesktopFamily,
  candidateIds: string[],
  previousMain: string | undefined
): string {
  return `${family}/${preferredOrFirstModel(candidateIds, previousMain?.split("/")[1] ?? previousMain, ["glm-5.2", "glm-5.3"])}`;
}

function selectLiteModel(
  family: DesktopFamily,
  candidateIds: string[],
  mainModel: string,
  previousLite: string | undefined
): string {
  const liteId = modelIdInCandidates(candidateIds, previousLite?.split("/")[1] ?? previousLite)
    ?? modelIdInCandidates(candidateIds, "glm-5-turbo");
  return `${family}/${liteId ?? mainModel.split("/")[1]!}`;
}

export async function applyDesktopMigration(
  plan: DesktopMigrationPlan,
  options: {
    env?: NodeJS.ProcessEnv;
    family?: DesktopFamily;
  } = {}
): Promise<MigrationApplyResult> {
  const env = options.env ?? process.env;
  const family = options.family ?? plan.defaultFamily ?? plan.families[0]?.family;
  if (!family) throw new Error("No desktop provider families are available to migrate.");
  const familyPlanEntry = plan.families.find((entry) => entry.family === family);
  if (!familyPlanEntry) throw new Error(`Desktop settings contain no migratable ${family} provider.`);

  const configPath = userConfigPath(env);
  const previous: UserConfigRecord = JSON.parse(await readFile(configPath, "utf8"));
  const previousModel = isRecord(previous.model) ? previous.model : {};
  const previousMain = typeof previousModel.main === "string" ? previousModel.main : undefined;
  const previousLite = typeof previousModel.lite === "string" ? previousModel.lite : undefined;
  const backupPath = `${configPath}.pre-migration.bak`;
  try {
    await copyFile(configPath, backupPath);
  } catch (error) {
    throw new Error(
      `Unable to back up ${configPath} to ${basename(backupPath)} before importing desktop settings: `
      + (error instanceof Error ? error.message : String(error)),
      { cause: error }
    );
  }

  await updateUserConfig((config) => {
    const providers = isRecord(config.provider) ? config.provider : {};
    const current = isRecord(providers[family])
      ? providers[family] as Record<string, unknown>
      : {} as Record<string, unknown>;
    const currentOptions = isRecord(current.options) ? current.options : {};
    const currentApiKey = typeof currentOptions.apiKey === "string" && currentOptions.apiKey.trim()
      ? currentOptions.apiKey
      : undefined;

    providers[family] = {
      ...current,
      kind: "anthropic",
      name: familyPlanEntry.providerName,
      options: {
        ...currentOptions,
        apiKeyRequired: true,
        ...(familyPlanEntry.baseURL ? { baseURL: familyPlanEntry.baseURL } : {}),
        ...(currentApiKey ? { apiKey: currentApiKey } : {})
      },
      models: mergeModels(
        isRecord(current.models) ? current.models : undefined,
        familyPlanEntry.models
      )
    };
    config.provider = providers;

    const migratedProvider = providers[family] as { models?: unknown };
    const mergedModelIds = Object.keys(isRecord(migratedProvider.models) ? migratedProvider.models : {});
    const main = selectMainModel(family, mergedModelIds, previousMain);
    config.model = {
      ...(isRecord(config.model) ? config.model : {}),
      main,
      lite: selectLiteModel(family, mergedModelIds, main, previousLite)
    };
  }, env);

  return { configPath, backupPath };
}
