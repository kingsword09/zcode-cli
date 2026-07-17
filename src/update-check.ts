import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

import { compareReleaseVersions, parseReleaseVersion } from "../scripts/release-version.ts";
import { userConfigPath } from "./model-access.ts";

export const UPDATE_CACHE_TTL_MS = 20 * 60 * 60 * 1_000;
export const UPDATE_CHECK_URL = "https://registry.npmjs.org/zcode-app-cli/latest";

interface UpdateCache {
  checkedVersion?: string;
  latestVersion: string;
  lastCheckedAt: string;
}

export interface StartupUpdateCheck {
  availableVersion?: string;
  cachePath: string;
  refreshRequired: boolean;
}

export type UpdateFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface ReadStartupUpdateOptions {
  cachePath?: string;
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

export interface RefreshUpdateCacheOptions {
  cachePath: string;
  currentVersion: string;
  fetcher?: UpdateFetcher;
  now?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function enabledEnvironmentFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledEnvironmentFlag(env.CI)
    || enabledEnvironmentFlag(env.NO_UPDATE_NOTIFIER)
    || enabledEnvironmentFlag(env.ZCODE_DISABLE_UPDATE_CHECK);
}

export function updateCachePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir()
): string {
  const path = platform === "win32" ? win32 : posix;
  return path.join(path.dirname(userConfigPath(env, platform, fallbackHome)), "version.json");
}

function parseUpdateCache(value: unknown): UpdateCache | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const cache = value as Record<string, unknown>;
  if (typeof cache.latestVersion !== "string" || !parseReleaseVersion(cache.latestVersion)) return undefined;
  if (typeof cache.lastCheckedAt !== "string" || !Number.isFinite(Date.parse(cache.lastCheckedAt))) return undefined;
  if (cache.checkedVersion !== undefined
    && (typeof cache.checkedVersion !== "string" || !parseReleaseVersion(cache.checkedVersion))) {
    return undefined;
  }
  return {
    checkedVersion: cache.checkedVersion as string | undefined,
    latestVersion: cache.latestVersion,
    lastCheckedAt: cache.lastCheckedAt
  };
}

async function readUpdateCache(cachePath: string): Promise<UpdateCache | undefined> {
  try {
    return parseUpdateCache(JSON.parse(await readFile(cachePath, "utf8")));
  } catch {
    return undefined;
  }
}

export async function readStartupUpdate(
  options: ReadStartupUpdateOptions
): Promise<StartupUpdateCheck | undefined> {
  const env = options.env ?? process.env;
  if (updateCheckDisabled(env) || !parseReleaseVersion(options.currentVersion)) return undefined;

  const cachePath = options.cachePath ?? updateCachePath(env);
  const cache = await readUpdateCache(cachePath);
  const now = options.now ?? Date.now();
  const checkedAt = cache ? Date.parse(cache.lastCheckedAt) : Number.NaN;
  const refreshRequired = !cache
    || cache.checkedVersion !== options.currentVersion
    || checkedAt < now - UPDATE_CACHE_TTL_MS;
  const availableVersion = cache
    ? availableUpdateVersion(options.currentVersion, cache.latestVersion)
    : undefined;
  return { availableVersion, cachePath, refreshRequired };
}

export function availableUpdateVersion(
  currentVersion: string,
  latestVersion: string
): string | undefined {
  if (!parseReleaseVersion(currentVersion) || !parseReleaseVersion(latestVersion)) return undefined;
  return compareReleaseVersions(latestVersion, currentVersion) > 0 ? latestVersion : undefined;
}

async function writeUpdateCache(cachePath: string, cache: UpdateCache): Promise<void> {
  const directory = dirname(cachePath);
  const temporaryPath = join(directory, `.version.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(temporaryPath, cachePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function refreshUpdateCache(options: RefreshUpdateCacheOptions): Promise<string> {
  if (!parseReleaseVersion(options.currentVersion)) {
    throw new Error(`Unsupported installed version: ${options.currentVersion}`);
  }

  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("Update check timed out.")),
    options.timeoutMs ?? 5_000
  );
  timeout.unref?.();

  try {
    const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    const response = await fetcher(UPDATE_CHECK_URL, {
      headers: {
        accept: "application/json",
        "user-agent": `zcode-app-cli/${options.currentVersion}`
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}.`);
    const body: unknown = await response.json();
    const latestVersion = typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).version
      : undefined;
    if (typeof latestVersion !== "string" || !parseReleaseVersion(latestVersion)) {
      throw new Error("npm registry returned an invalid release version.");
    }
    await writeUpdateCache(options.cachePath, {
      checkedVersion: options.currentVersion,
      latestVersion,
      lastCheckedAt: new Date(options.now ?? Date.now()).toISOString()
    });
    return latestVersion;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
