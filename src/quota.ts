import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, release, userInfo } from "node:os";
import { join } from "node:path";
import { credentialsPath, sharedDataBaseDir } from "./config-paths.ts";
import { readStartPlanSession } from "./start-plan.ts";

/**
 * Plan-quota service for the standalone CLI/TUI.
 *
 * Reads the shared OAuth session (`readStartPlanSession`) from the runtime-owned
 * credentials file, queries the Start Plan billing/balance endpoint with the
 * same device identity the runtime already uses, and parses the per-model
 * balance slots shown by the desktop's Start Plan panel.
 *
 * Read-only: this module never writes credentials and never creates identities.
 */

const BILLING_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const DEFAULT_APP_VERSION = "3.18.2";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_MIN_BYTES = 32;
const SECRET_MAX_BYTES = 4096;

export interface QuotaSlot {
  name: string | undefined;
  meter: string | undefined;
  totalUnits: number | undefined;
  usedUnits: number | undefined;
  remainingUnits: number | undefined;
  availableUnits: number | undefined;
  percentLeft: number | undefined;
  expiresAt: number | undefined;
}

export interface QuotaPlan {
  planId: string | undefined;
  name: string | undefined;
  status: string | undefined;
  startsAt: number | undefined;
  endsAt: number | undefined;
}

export interface QuotaOverview {
  serverTime: number | undefined;
  plans: QuotaPlan[];
  balances: QuotaSlot[];
}

export interface QuotaSession {
  family: "zai" | "bigmodel";
  identity: string;
  token: string;
}

export type QuotaReadResult =
  | { ok: true; overview: QuotaOverview }
  | {
      ok: false;
      reason: "no-oauth-session" | "secure-storage-unavailable" | "request-failed";
      detail?: string;
    };

interface CredentialReader {
  loadMany(keys: string[]): Promise<Record<string, string | null>>;
}

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function keyFingerprint(key: Buffer): string {
  return digest(key).toString("hex").slice(0, 24);
}

function isPrintableBase64Url(part: string): boolean {
  return /^[A-Za-z0-9_-]*$/.test(part);
}

/** `enc:v2:env:<keyFingerprint>:<iv>.<tag>.<ct>` — base64url, AES-256-GCM, no AAD. */
function tryOpenV2Env(body: string, secretCandidates: string[]): string | undefined {
  const colon = body.indexOf(":");
  const fingerprint = colon >= 0 ? body.slice(0, colon) : undefined;
  const payload = colon >= 0 ? body.slice(colon + 1) : body;
  const parts = payload.split(".");
  if (parts.length !== 3 || parts.some(part => !isPrintableBase64Url(part))) return undefined;
  const [iv, tag, bytes] = parts.map(part => Buffer.from(part, "base64url"));
  if (!iv || !tag || !bytes || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return undefined;
  for (const candidate of secretCandidates) {
    const key = digest(candidate);
    if (fingerprint && fingerprint !== keyFingerprint(key)) continue;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8");
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** `enc:v1:<iv>.<tag>.<ct>` — legacy records; key candidates mirror the runtime. */
function tryOpenLegacy(record: string, env: NodeJS.ProcessEnv): string | undefined {
  const body = record.replace(/^enc:v1:/, "");
  const parts = body.split(".");
  if (parts.length !== 3 || parts.some(part => !isPrintableBase64Url(part))) return undefined;
  const [iv, tag, bytes] = parts.map(part => Buffer.from(part, "base64url"));
  if (!iv || !tag || !bytes || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return undefined;
  const fallback = legacyFallbackSecret(env);
  const secret = resolveCredentialSecret(env);
  const candidates = secret
    ? [...new Set([secret, secret.trim(), fallback])]
    : [fallback];
  for (const key of candidates.map(digest)) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8");
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function legacyFallbackSecret(env: NodeJS.ProcessEnv): string {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // userInfo can fail on restricted passwd access; the runtime uses "unknown" too
  }
  return `zcode-credential-fallback:${process.platform}:${homedir()}:${username}`;
}

/**
 * Mirrors the runtime's managed-secret resolution: the env variable wins, then
 * the secret file whose content is used verbatim (no trim — the runtime derives
 * its key from the raw file content, trailing newline included).
 */
function resolveCredentialSecret(env: NodeJS.ProcessEnv): string | undefined {
  if (env.ZCODE_CREDENTIAL_SECRET && env.ZCODE_CREDENTIAL_SECRET_FILE) return undefined;
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET;
  const explicit = env.ZCODE_CREDENTIAL_SECRET_FILE;
  if (!explicit) return undefined;
  try {
    const value = readFileSync(explicit, "utf8");
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes < SECRET_MIN_BYTES || bytes > SECRET_MAX_BYTES) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function decryptRecord(value: string, env: NodeJS.ProcessEnv): string | null {
  if (value.startsWith("enc:v2:env:")) {
    const secret = resolveCredentialSecret(env);
    const candidates = secret ? [...new Set([secret, secret.trim()])] : [];
    return tryOpenV2Env(value.slice("enc:v2:env:".length), candidates) ?? null;
  }
  if (value.startsWith("enc:v1:")) return tryOpenLegacy(value, env) ?? null;
  if (value.startsWith("enc:v2:os:")) return null; // keyring-protected: not readable outside the owning environment
  return value; // plaintext record
}

/**
 * Read-only CredentialReader over the runtime-owned credentials file.
 * Follows the same path resolution as the runtime (config-paths helpers),
 * so an isolated `ZCODE_DATA_BASE_DIR` yields that account's records only.
 */
export function createFileCredentialReader(env: NodeJS.ProcessEnv = process.env): CredentialReader {
  return {
    async loadMany(keys: string[]): Promise<Record<string, string | null>> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(credentialsPath(env), "utf8"));
      } catch {
        return Object.fromEntries(keys.map(key => [key, null]));
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return Object.fromEntries(keys.map(key => [key, null]));
      }
      const records = parsed as Record<string, unknown>;
      return Object.fromEntries(keys.map(key => {
        const value = records[key];
        const plain = typeof value === "string" ? decryptRecord(value, env) : null;
        return [key, plain && plain.length > 0 ? plain : null];
      }));
    }
  };
}

/** DeviceMid from the isolated telemetry state — the runtime creates it on first model request. */
export function readDeviceMid(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const stateFile = join(sharedDataBaseDir(env), ".zcode", "v2", "telemetry-state.json");
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as { deviceMid?: unknown };
    const mid = parsed.deviceMid;
    return typeof mid === "string" && mid.trim() ? mid.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Billing-plane headers, mirroring the desktop's Start Plan request shape
 * (User-Agent/Referer/Title/Version/Platform/Channel/Language/Timezone/OS/
 * Device-Mid/Authorization + a fresh x-request-id per call).
 */
export function billingHeaders(
  session: QuotaSession,
  options: { deviceMid?: string; appVersion?: string } = {},
): Record<string, string> {
  const version = options.appVersion ?? DEFAULT_APP_VERSION;
  const headers: Record<string, string> = {
    "User-Agent": `ZCode/${version}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": version,
    "X-Platform": process.platform,
    "X-Release-Channel": "stable",
    "X-Client-Language": Intl.DateTimeFormat().resolvedOptions().locale || "unknown",
    "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
    "X-Os-Category": process.platform,
    "X-Os-Version": release(),
    "Authorization": `Bearer ${session.token}`,
    "x-request-id": randomUUID()
  };
  if (options.deviceMid) headers["X-Device-Mid"] = options.deviceMid;
  return headers;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Pure parser for the billing/balance payload (accepts the `{code, data}` envelope or bare data). */
export function parseBillingBalance(payload: unknown): QuotaOverview {
  const envelope = asRecord(payload);
  const root = envelope && "data" in envelope ? asRecord(envelope.data) : envelope;
  if (!root) return { serverTime: undefined, plans: [], balances: [] };

  const plans = Array.isArray(root.plans)
    ? root.plans.map(plan => {
        const record = asRecord(plan) ?? {};
        return {
          planId: asText(record.plan_id),
          name: asText(record.name),
          status: asText(record.status),
          startsAt: asNumber(record.starts_at),
          endsAt: asNumber(record.ends_at)
        };
      })
    : [];
  const balances = Array.isArray(root.balances)
    ? root.balances.map(balance => {
        const record = asRecord(balance) ?? {};
        const totalUnits = asNumber(record.total_units);
        const remainingUnits = asNumber(record.remaining_units);
        const percentLeft = totalUnits !== undefined && totalUnits > 0 && remainingUnits !== undefined
          ? Math.max(0, Math.min(100, (remainingUnits / totalUnits) * 100))
          : undefined;
        return {
          name: asText(record.show_name),
          meter: asText(record.meter),
          totalUnits,
          usedUnits: asNumber(record.used_units),
          remainingUnits,
          availableUnits: asNumber(record.available_units),
          percentLeft,
          expiresAt: asNumber(record.expires_at)
        };
      })
    : [];
  return { serverTime: asNumber(root.server_time), plans, balances };
}

export class QuotaRequestError extends Error {}

export async function fetchQuotaOverview(
  session: QuotaSession,
  options: {
    deviceMid?: string;
    appVersion?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<QuotaOverview> {
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(BILLING_BALANCE_URL, {
      headers: billingHeaders(session, options),
      signal: options.signal
    });
  } catch (error) {
    throw new QuotaRequestError(error instanceof Error ? error.message : String(error));
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new QuotaRequestError(`billing/balance returned non-JSON response (HTTP ${response.status})`);
  }
  const envelope = asRecord(payload);
  if (response.status !== 200 || (envelope && envelope.code !== undefined && envelope.code !== 0)) {
    const message = envelope && typeof envelope.msg === "string" ? envelope.msg : `HTTP ${response.status}`;
    throw new QuotaRequestError(`billing/balance rejected the request: ${message}`);
  }
  return parseBillingBalance(payload);
}

/**
 * One-shot read for the TUI: shared OAuth session → billing/balance → parsed overview.
 * Fails soft with a reason the UI can present.
 */
export async function loadCurrentQuotaOverview(
  options: {
    env?: NodeJS.ProcessEnv;
    appVersion?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<QuotaReadResult> {
  const env = options.env ?? process.env;
  const session = await readStartPlanSession(createFileCredentialReader(env), options.signal);
  if (!session) return { ok: false, reason: "no-oauth-session" };
  try {
    const overview = await fetchQuotaOverview(session, {
      deviceMid: readDeviceMid(env),
      appVersion: options.appVersion,
      signal: options.signal,
      fetchImpl: options.fetchImpl
    });
    return { ok: true, overview };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = detail.includes("Secure credential storage") || detail.includes("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE")
      ? "secure-storage-unavailable"
      : "request-failed";
    return { ok: false, reason, detail };
  }
}

