import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { updateUserConfig } from "./model-access.ts";

export const MODEL_CATALOG_REFRESH_TTL_MS = 6 * 60 * 60 * 1_000;
export const MODEL_CATALOG_URL_PATH = "/api/v1/client/configs";
const DEFAULT_TIMEOUT_MS = 5_000;
const PROVIDER_BASE_URLS = {
  zai: "https://api.z.ai/api/anthropic",
  bigmodel: "https://open.bigmodel.cn/api/anthropic"
} as const;
type SupportedProviderId = keyof typeof PROVIDER_BASE_URLS;
const MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

interface RemoteBuiltinModel {
  modelId: string;
  name: string;
  contextWindow?: number;
  reasoning?: {
    levels?: Record<string, unknown>;
    defaultLevel?: string;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  maxCompletionTokens?: number;
}

interface RemoteBuiltinProvider {
  id: string;
  schema?: string;
  models: string[];
}

interface RemoteClientConfigs {
  builtinModels?: RemoteBuiltinModel[];
  builtinProviders?: RemoteBuiltinProvider[];
  retirementSafe?: boolean;
}

export type ModelCatalogFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface ModelCatalogCache {
  endpoint?: string;
  retirementSafe?: boolean;
  lastFetchedAt: string;
  builtinModels: RemoteBuiltinModel[];
  builtinProviders: RemoteBuiltinProvider[];
}

export interface RefreshModelCatalogOptions {
  baseUrl: string;
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  fetcher?: ModelCatalogFetcher;
  now?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RefreshModelCatalogResult {
  cachePath: string;
  refreshed: boolean;
  catalog: ModelCatalogCache | null;
}

function enabledEnvironmentFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function modelCatalogRefreshDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledEnvironmentFlag(env.CI)
    || enabledEnvironmentFlag(env.ZCODE_DISABLE_MODEL_CATALOG_REFRESH);
}

export function modelCatalogCachePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir()
): string {
  const path = platform === "win32" ? win32 : posix;
  const configuredHome = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim();
  return path.join(configuredHome || fallbackHome, ".zcode", "cli", "model-catalog.json");
}

export function resolveModelCatalogEndpoint(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Model catalog endpoint must use HTTP or HTTPS.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${MODEL_CATALOG_URL_PATH}`;
  url.hash = "";
  url.searchParams.set("platform", `${platform}-${arch}`);
  const appVersion = env.ZCODE_APP_CLI_VERSION?.trim() || "";
  if (appVersion) url.searchParams.set("app_version", appVersion);
  return url.toString();
}

function catalogEndpoint(options: RefreshModelCatalogOptions): string {
  const env = options.env ?? process.env;
  return resolveModelCatalogEndpoint(options.baseUrl, {
    ...env,
    ZCODE_APP_CLI_VERSION: env.ZCODE_APP_CLI_VERSION?.trim() || options.currentVersion
  });
}

function toModelId(value: string): string {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value.trim());
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseModalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.filter((item): item is string => typeof item === "string" && MODALITIES.has(item));
  return valid.length > 0 || value.length === 0 ? [...new Set(valid)] : undefined;
}

function parseCatalog(data: unknown): RemoteClientConfigs {
  if (!isRecord(data)) return {};
  const builtinModels: RemoteBuiltinModel[] = [];
  const builtinProviders: RemoteBuiltinProvider[] = [];
  const candidates: unknown[] = Array.isArray(data.builtinModels) ? [...data.builtinModels] : [];
  // The official endpoint also advertises older supported models in providers.
  // Include that membership before deciding whether an auto-added model retired.
  for (const provider of Array.isArray(data.providers) ? data.providers : []) {
    if (!isRecord(provider) || provider.schema !== "anthropic" || !Array.isArray(provider.models)) continue;
    const family = provider.id === "z-ai" ? "zai" : provider.id === "bigmodel" ? "bigmodel" : undefined;
    if (!family || typeof provider.baseUrl !== "string"
      || provider.baseUrl.trim().replace(/\/+$/u, "") !== PROVIDER_BASE_URLS[family]) continue;
    candidates.push(...provider.models);
    builtinProviders.push({
      id: `builtin:${family}-coding-plan`, schema: "anthropic",
      models: provider.models.flatMap((model) => isRecord(model) && modelId(model.modelId) ? [model.modelId] : [])
    });
  }
  const seen = new Set<string>();
  for (const value of candidates) {
    if (!isRecord(value) || !modelId(value.modelId)) continue;
    const id = toModelId(value.modelId);
    if (seen.has(id)) continue;
    seen.add(id);
    const model: RemoteBuiltinModel = {
      modelId: value.modelId.trim(),
      name: typeof value.name === "string" && value.name.trim()
        ? value.name.trim() : value.modelId.trim()
    };
    if (positiveInteger(value.contextWindow)) model.contextWindow = value.contextWindow;
    if (positiveInteger(value.maxCompletionTokens)) model.maxCompletionTokens = value.maxCompletionTokens;
    if (isRecord(value.modalities)) {
      const input = parseModalities(value.modalities.input);
      const output = parseModalities(value.modalities.output);
      if (input || output) model.modalities = { ...(input ? { input } : {}), ...(output ? { output } : {}) };
    }
    if (isRecord(value.reasoning) && isRecord(value.reasoning.levels)) {
      model.reasoning = {
        levels: value.reasoning.levels,
        ...(typeof value.reasoning.defaultLevel === "string" ? { defaultLevel: value.reasoning.defaultLevel } : {})
      };
    }
    builtinModels.push(model);
  }
  for (const value of Array.isArray(data.builtinProviders) ? data.builtinProviders : []) {
    if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.models)) continue;
    builtinProviders.push({
      id: value.id,
      ...(typeof value.schema === "string" ? { schema: value.schema } : {}),
      models: value.models.filter(modelId).map((id) => id.trim())
    });
  }
  return { builtinModels, builtinProviders };
}

function usableCatalog(catalog: RemoteClientConfigs): boolean {
  const ids = new Set(catalog.builtinModels?.map((model) => toModelId(model.modelId)));
  return catalog.builtinProviders?.some((provider) => (
    providerFamilyForBuiltinId(provider.id) !== undefined
    && (provider.schema === undefined || provider.schema === "anthropic")
    && provider.models.some((id) => ids.has(toModelId(id)))
  )) ?? false;
}

function completeModelList(value: unknown): boolean {
  return Array.isArray(value) && value.every((model) => isRecord(model) && modelId(model.modelId));
}

function completeBuiltinLists(value: Record<string, unknown>): boolean {
  return completeModelList(value.builtinModels) && Array.isArray(value.builtinProviders)
    && value.builtinProviders.every((provider) => isRecord(provider) && typeof provider.id === "string"
      && Array.isArray(provider.models) && provider.models.every(modelId));
}

async function readCatalogCache(cachePath: string, endpoint: string): Promise<ModelCatalogCache | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    if (!isRecord(value) || value.endpoint !== endpoint) return undefined;
    const lastFetchedAt = typeof value.lastFetchedAt === "string" ? value.lastFetchedAt : undefined;
    if (!lastFetchedAt || !Number.isFinite(Date.parse(lastFetchedAt))) return undefined;
    const catalog = parseCatalog(value);
    if (!usableCatalog(catalog)) return undefined;
    return {
      endpoint, lastFetchedAt,
      retirementSafe: value.retirementSafe === true && completeBuiltinLists(value),
      builtinModels: catalog.builtinModels!, builtinProviders: catalog.builtinProviders!
    };
  } catch {
    return undefined;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.model-catalog.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function parseRemoteClientConfigs(body: unknown): RemoteClientConfigs {
  if (!isRecord(body) || body.code !== 0) return {};
  const data = body.data;
  const catalog = parseCatalog(data);
  catalog.retirementSafe = isRecord(data) && completeBuiltinLists(data)
    && Array.isArray(data.providers) && data.providers.every((provider) => (
      isRecord(provider) && typeof provider.id === "string" && typeof provider.schema === "string"
      && typeof provider.baseUrl === "string" && completeModelList(provider.models)
    ));
  return catalog;
}

export async function fetchRemoteModelCatalog(
  options: RefreshModelCatalogOptions
): Promise<RemoteClientConfigs> {
  if (options.signal?.aborted) return {};
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("Model catalog refresh timed out.")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  try {
    const url = catalogEndpoint(options);
    const fetcher = options.fetcher ?? ((requestUrl, init) => fetch(requestUrl, init));
    const response = await fetcher(url, {
      headers: {
        accept: "application/json",
        "user-agent": `zcode-app-cli/${options.currentVersion}`
      },
      signal: controller.signal
    });
    if (!response.ok) return {};
    const body: unknown = await response.json();
    return parseRemoteClientConfigs(body);
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function refreshModelCatalog(
  options: RefreshModelCatalogOptions
): Promise<RefreshModelCatalogResult> {
  const env = options.env ?? process.env;
  const cachePath = modelCatalogCachePath(env);
  const now = options.now ?? Date.now();
  if (modelCatalogRefreshDisabled(env) || options.signal?.aborted) {
    return { cachePath, refreshed: false, catalog: null };
  }

  let endpoint: string;
  try {
    endpoint = catalogEndpoint(options);
  } catch {
    return { cachePath, refreshed: false, catalog: null };
  }

  const cached = await readCatalogCache(cachePath, endpoint);
  const existing = cached && Date.parse(cached.lastFetchedAt) <= now ? cached : undefined;
  const age = existing ? now - Date.parse(existing.lastFetchedAt) : Infinity;
  if (existing && age >= 0 && age < MODEL_CATALOG_REFRESH_TTL_MS) {
    return { cachePath, refreshed: false, catalog: existing };
  }

  const remote = await fetchRemoteModelCatalog(options);
  if (options.signal?.aborted) return { cachePath, refreshed: false, catalog: null };
  if (!usableCatalog(remote)) {
    return { cachePath, refreshed: false, catalog: existing ?? null };
  }

  const cache: ModelCatalogCache = {
    endpoint,
    retirementSafe: remote.retirementSafe === true,
    lastFetchedAt: new Date(now).toISOString(),
    builtinModels: remote.builtinModels ?? [],
    builtinProviders: remote.builtinProviders ?? []
  };
  await writePrivateJson(cachePath, cache).catch(() => {});
  return { cachePath, refreshed: true, catalog: cache };
}

function providerFamilyForBuiltinId(builtinId: string): SupportedProviderId | undefined {
  if (builtinId === "builtin:zai-coding-plan") return "zai";
  if (builtinId === "builtin:bigmodel-coding-plan") return "bigmodel";
  return undefined;
}

function buildReasoning(model: RemoteBuiltinModel): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {};
  // Translate only the official Anthropic effort mapping supported by this runtime.
  for (const [level, value] of Object.entries(model.reasoning?.levels ?? {})) {
    if (!modelId(level) || !isRecord(value) || !isRecord(value.anthropic)) continue;
    const operations = value.anthropic.set;
    if (!Array.isArray(operations) || operations.length !== 1 || value.anthropic.unset !== undefined) continue;
    const operation = operations[0];
    if (!isRecord(operation) || !Array.isArray(operation.path)
      || operation.path.length !== 2 || operation.path[0] !== "output_config" || operation.path[1] !== "effort"
      || typeof operation.value !== "string" || !EFFORTS.has(operation.value)) continue;
    options[level] = { anthropic: { effort: operation.value } };
  }
  const levels = Object.keys(options);
  if (!levels.length) return undefined;
  const defaultLevel = model.reasoning?.defaultLevel;
  return {
    enabled: true,
    levels,
    ...(defaultLevel && levels.includes(defaultLevel) ? { defaultLevel } : {}),
    providerOptionsByLevel: options
  };
}

function buildModelEntry(model: RemoteBuiltinModel): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: model.name };
  if (typeof model.contextWindow === "number") {
    entry.limit = {
      context: model.contextWindow,
      ...(typeof model.maxCompletionTokens === "number" ? { output: model.maxCompletionTokens } : {})
    };
  } else if (typeof model.maxCompletionTokens === "number") {
    entry.limit = { output: model.maxCompletionTokens };
  }
  if (model.modalities && (model.modalities.input || model.modalities.output)) {
    entry.modalities = {
      ...(model.modalities.input ? { input: model.modalities.input } : {}),
      ...(model.modalities.output ? { output: model.modalities.output } : {})
    };
  }
  const reasoning = buildReasoning(model);
  if (reasoning) entry.reasoning = reasoning;
  return entry;
}

function isOfficialProvider(provider: Record<string, unknown>, family: SupportedProviderId): boolean {
  if (provider.kind !== "anthropic" || !isRecord(provider.options)) return false;
  const baseURL = provider.options.baseURL;
  return typeof baseURL === "string" && baseURL.trim().replace(/\/+$/u, "") === PROVIDER_BASE_URLS[family];
}

function mergeModelEntry(entry: Record<string, unknown>, existing: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...entry, ...existing };
  for (const key of ["limit", "modalities"]) {
    if (isRecord(entry[key]) && isRecord(existing[key])) merged[key] = { ...entry[key], ...existing[key] };
  }
  return merged;
}

interface ManagedCatalog {
  endpoint: string;
  models: Record<string, Record<string, unknown>>;
}

function catalogSource(endpoint: string): string {
  if (!endpoint) return "";
  const url = new URL(endpoint);
  url.searchParams.delete("app_version");
  url.searchParams.delete("platform");
  return url.toString();
}

async function readManagedCatalog(path: string, endpoint: string): Promise<ManagedCatalog> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(value) && value.endpoint === endpoint && isRecord(value.models)) {
      return {
        endpoint,
        models: Object.fromEntries(Object.entries(value.models).filter(
          (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])
        ))
      };
    }
  } catch {
    // Missing provenance means existing entries are user-owned.
  }
  return { endpoint, models: {} };
}

export async function applyRefreshedModelsToConfig(
  result: RefreshModelCatalogResult,
  env: NodeJS.ProcessEnv = process.env,
  protectedModels: string[] = []
): Promise<void> {
  const catalog = parseCatalog(result.catalog);
  if (!usableCatalog(catalog)) return;
  const age = Date.now() - Date.parse(result.catalog!.lastFetchedAt);
  const retire = result.refreshed && result.catalog?.retirementSafe === true
    && age >= 0 && age < MODEL_CATALOG_REFRESH_TTL_MS;
  const managedPath = join(dirname(modelCatalogCachePath(env)), "model-catalog-managed.json");
  const managed = await readManagedCatalog(managedPath, catalogSource(result.catalog?.endpoint ?? ""));
  const beforeManaged = JSON.stringify(managed);

  const modelsByFamily = new Map<SupportedProviderId, Map<string, Record<string, unknown>>>();
  const incompleteFamilies = new Set<SupportedProviderId>();
  const models = new Map(catalog.builtinModels!.map((model) => [toModelId(model.modelId), model]));
  for (const provider of catalog.builtinProviders!) {
    const family = providerFamilyForBuiltinId(provider.id);
    if (!family || (provider.schema !== undefined && provider.schema !== "anthropic")) continue;
    const familyModels = modelsByFamily.get(family) ?? new Map();
    // An incomplete provider response cannot establish that a model retired.
    if (!provider.models.length || provider.models.some((id) => !models.has(toModelId(id)))) {
      incompleteFamilies.add(family);
      continue;
    }
    for (const id of provider.models) {
      const model = models.get(toModelId(id));
      if (model) familyModels.set(toModelId(id), buildModelEntry(model));
    }
    modelsByFamily.set(family, familyModels);
  }

  await updateUserConfig((config) => {
    if (!isRecord(config.provider)) return;
    const providers = config.provider;
    const selected = new Set(protectedModels.map(toModelId));
    if (typeof config.model === "string") selected.add(toModelId(config.model));
    if (isRecord(config.model)) {
      for (const value of Object.values(config.model)) if (typeof value === "string") selected.add(toModelId(value));
    }
    const overrides = isRecord(config.modelCatalog) && isRecord(config.modelCatalog.overrides)
      ? config.modelCatalog.overrides : {};
    for (const [providerId, familyModels] of modelsByFamily) {
      const current = providers[providerId];
      if (!isRecord(current) || !isOfficialProvider(current, providerId)) continue;
      const currentModels = isRecord(current.models) ? current.models as Record<string, unknown> : {};
      const merged: Record<string, unknown> = { ...currentModels };
      const existingIds = new Map(Object.keys(currentModels).map((id) => [toModelId(id), id]));
      for (const [id, existing] of Object.entries(currentModels)) {
        const reference = `${providerId}/${id}`;
        if (retire && !incompleteFamilies.has(providerId)
          && !familyModels.has(toModelId(id)) && !selected.has(toModelId(reference))
          && !Object.hasOwn(overrides, reference) && isDeepStrictEqual(existing, managed.models[reference])) {
          delete merged[id];
          delete managed.models[reference];
        }
      }
      for (const [modelId, entry] of familyModels) {
        const id = existingIds.get(modelId) ?? modelId;
        const existing = merged[id];
        if (Object.hasOwn(merged, id) && !isRecord(existing)) continue;
        const reference = `${providerId}/${id}`;
        const owned = !Object.hasOwn(merged, id)
          || isDeepStrictEqual(existing, managed.models[reference]);
        merged[id] = owned ? entry : mergeModelEntry(entry, existing as Record<string, unknown>);
        if (owned) managed.models[reference] = entry;
      }
      providers[providerId] = { ...current, models: merged };
    }
    config.provider = providers;
  }, env);
  if (JSON.stringify(managed) !== beforeManaged) await writePrivateJson(managedPath, managed);
}

/** Download in the background; sync only at a model-selection boundary. */
export class ModelCatalogRefresh {
  private controller = new AbortController();
  private pending?: Promise<void>;
  private result?: RefreshModelCatalogResult;
  private nextRefreshAt = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: RefreshModelCatalogOptions) {}

  start(): void {
    if (this.controller.signal.aborted || this.pending || Date.now() < this.nextRefreshAt
      || modelCatalogRefreshDisabled(this.options.env)) return;
    clearTimeout(this.timer);
    this.pending = refreshModelCatalog({ ...this.options, signal: this.controller.signal })
      .then((result) => {
        if (!this.controller.signal.aborted) {
          if (result.catalog) this.result = result;
          else if (this.result) this.result = { ...this.result, refreshed: false };
        }
        this.nextRefreshAt = result.catalog
          ? Math.max(Date.now() + 60_000, Date.parse(result.catalog.lastFetchedAt) + MODEL_CATALOG_REFRESH_TTL_MS)
          : Date.now() + 60_000;
      })
      .catch(() => {
        if (this.result) this.result = { ...this.result, refreshed: false };
        this.nextRefreshAt = Date.now() + 60_000;
      })
      .finally(() => {
        this.pending = undefined;
        if (!this.controller.signal.aborted) {
          this.timer = setTimeout(() => this.start(), Math.max(1, this.nextRefreshAt - Date.now()));
          this.timer.unref?.();
        }
      });
  }

  async apply(protectedModels: string[] = []): Promise<void> {
    this.start();
    // Never await the fetch: first-run/offline users keep the bundled catalog.
    if (this.result && !this.controller.signal.aborted && !modelCatalogRefreshDisabled(this.options.env)) {
      await applyRefreshedModelsToConfig(this.result, this.options.env, protectedModels);
    }
  }

  stop(): void {
    clearTimeout(this.timer);
    this.controller.abort();
  }
}
