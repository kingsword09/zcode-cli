import { createHash } from "node:crypto";
import { profileIdentity } from "./shared-oauth.ts";

interface CredentialReader {
  loadMany(keys: string[]): Promise<Record<string, string | null>>;
}

interface StartPlanSession {
  family: "zai" | "bigmodel";
  identity: string;
  token: string;
}

interface StartPlanRequest {
  providerId: string;
  accountAccess?: { mode?: string; accountType?: string };
  expectedAccountScope?: string;
  rejectedProjectTokenFingerprint?: string;
  abortSignal?: AbortSignal;
}

function usableToken(value: string | null | undefined): string | undefined {
  const token = value?.trim().replace(/^Bearer\s+/iu, "").trim();
  const parts = token?.split(".");
  if (!parts || parts.length !== 3 || parts.some(part => !part)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return undefined;
    const now = Date.now() / 1000;
    if (claims.exp !== undefined && (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now)) return undefined;
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now)) return undefined;
    return token;
  } catch {
    return undefined;
  }
}

export async function readStartPlanSession(store: CredentialReader, signal?: AbortSignal): Promise<StartPlanSession | undefined> {
  signal?.throwIfAborted();
  const activeKey = "oauth:active_provider", tokenKey = "zcodejwttoken";
  const active = await store.loadMany([activeKey]);
  signal?.throwIfAborted();
  const family = active[activeKey];
  if (family !== "zai" && family !== "bigmodel") return undefined;
  const profileKey = `oauth:${family}:user_info`;
  const keys = [activeKey, tokenKey, profileKey];
  const values = await store.loadMany(keys);
  signal?.throwIfAborted();
  const identity = profileIdentity(values[profileKey]), token = usableToken(values[tokenKey]);
  if (values[activeKey] !== family || !identity || !token) return undefined;
  const current = await store.loadMany(keys);
  signal?.throwIfAborted();
  if (keys.some(key => current[key] !== values[key])) return undefined;
  return { family, identity, token };
}

export async function refreshStandaloneStartPlanRequest(store: CredentialReader, input: StartPlanRequest) {
  input.abortSignal?.throwIfAborted();
  const family = input.accountAccess?.accountType;
  if (input.accountAccess?.mode !== "start-plan" || (family !== "zai" && family !== "bigmodel")
    || input.providerId.trim() !== `account:${family}-start-plan`) {
    throw new Error("start_plan_account_required");
  }
  const session = await readStartPlanSession(store, input.abortSignal);
  if (!session || session.family !== family) {
    if (input.expectedAccountScope || input.rejectedProjectTokenFingerprint) throw new Error("project_token_scope_invalidated");
    throw new Error("start_plan_login_required: Sign in to ZCode once to use both Coding Plan and Start Plan; a Coding Plan API key alone is not a ZCode session.");
  }
  const accountScope = createHash("sha256").update(JSON.stringify([
    input.providerId.trim(), session.family, session.identity, session.token,
  ])).digest("hex");
  if ((input.expectedAccountScope && input.expectedAccountScope !== accountScope)
    || (input.rejectedProjectTokenFingerprint && !input.expectedAccountScope)) {
    throw new Error("project_token_scope_invalidated");
  }
  if (input.rejectedProjectTokenFingerprint === createHash("sha256").update(session.token).digest("hex")) {
    throw new Error("start_plan_session_rejected: ZCode rejected the shared session; sign in to ZCode again.");
  }
  return { headersApplied: true, requestAuth: { apiKey: session.token, accountScope } };
}
