import { expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  billingHeaders,
  createFileCredentialReader,
  fetchQuotaOverview,
  loadCurrentQuotaOverview,
  parseBillingBalance,
  readDeviceMid
} from "../src/quota.ts";
import { readStartPlanSession } from "../src/start-plan.ts";

// Random per run: the seal/decrypt round-trip shares this constant, so the test
// stays deterministic without baking any secret material into the repository.
const SECRET = randomBytes(32).toString("hex");
const APP_JWT = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture-signature`;

function sealV2Env(value: string, secret = SECRET): string {
  const key = createHash("sha256").update(secret, "utf8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 24);
  const payload = [iv, cipher.getAuthTag(), bytes].map(part => part.toString("base64url")).join(".");
  return `enc:v2:env:${fingerprint}:${payload}`;
}

function sealV2Os(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 24);
  const payload = [iv, cipher.getAuthTag(), bytes].map(part => part.toString("base64url")).join(".");
  return `enc:v2:os:${fingerprint}:${payload}`;
}

/** The real billing/balance shape captured from a Start Plan account (values adjusted). */
function billingFixture(): unknown {
  return {
    code: 0,
    msg: "",
    data: {
      server_time: 1795285880,
      plans: [{
        user_plan_id: "upl_1",
        plan_id: "zcode-v3-start-plan-wk-1120",
        name: "ZCODE WEEKEND BUILD",
        description: "",
        priority: 101,
        status: "active",
        starts_at: 1795187372,
        ends_at: 1795395600,
        entitlements: [{
          entitlement_id: "ent-1",
          show_name: "GLM-5.3-Flash",
          meter: "model_usage",
          unit_type: "token",
          capabilities: ["model:glm-5.3-flash"],
          grant_units: 500000000,
          period: "one_time",
          priority: 101,
          effective_at: 1795186800
        }]
      }],
      balances: [{
        bucket_id: "bucket_1",
        user_plan_id: "upl_1",
        plan_id: "zcode-v3-start-plan-wk-1120",
        entitlement_id: "ent-1",
        show_name: "GLM-5.3-Flash",
        meter: "model_usage",
        unit_type: "token",
        capabilities: ["model:glm-5.3-flash"],
        priority: 101,
        plan_priority: 101,
        entitlement_priority: 101,
        total_units: 500000000,
        used_units: 200179,
        remaining_units: 499799821,
        available_units: 499799821,
        period_start: 1795187372,
        period_end: 1795395600,
        expires_at: 1795395600
      }]
    }
  };
}

function isolatedEnv(files: Record<string, string>): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "zcode-quota-test-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  const secretFile = join(dir, ".zcred");
  writeFileSync(secretFile, SECRET);
  return {
    dir,
    env: {
      ZCODE_DATA_BASE_DIR: dir,
      ZCODE_CREDENTIAL_SECRET_FILE: secretFile
    } as NodeJS.ProcessEnv
  };
}

test("parseBillingBalance maps plans and per-model balances with percent left", () => {
  const overview = parseBillingBalance(billingFixture());
  expect(overview.serverTime).toBe(1795285880);
  expect(overview.plans).toHaveLength(1);
  expect(overview.plans[0]).toMatchObject({
    planId: "zcode-v3-start-plan-wk-1120",
    name: "ZCODE WEEKEND BUILD",
    status: "active",
    endsAt: 1795395600
  });
  expect(overview.balances).toHaveLength(1);
  expect(overview.balances[0]).toMatchObject({
    name: "GLM-5.3-Flash",
    meter: "model_usage",
    totalUnits: 500000000,
    usedUnits: 200179,
    remainingUnits: 499799821,
    availableUnits: 499799821,
    expiresAt: 1795395600
  });
  expect(overview.balances[0]?.percentLeft).toBeCloseTo(99.9599642, 4);
});

test("parseBillingBalance renders every model slot a plan carries", () => {
  const fixture = billingFixture() as { data: { balances: Array<Record<string, unknown>> } };
  fixture.data.balances.push({
    bucket_id: "bucket_2",
    show_name: "GLM-5.3",
    meter: "model_usage",
    unit_type: "token",
    total_units: 200000000,
    used_units: 200000000,
    remaining_units: 0,
    available_units: 0,
    expires_at: 1795395600
  });
  const overview = parseBillingBalance(fixture);
  expect(overview.balances).toHaveLength(2);
  expect(overview.balances[1]?.name).toBe("GLM-5.3");
  expect(overview.balances[1]?.percentLeft).toBe(0);
});

test("parseBillingBalance accepts a bare payload and empty plan lists", () => {
  const bare = parseBillingBalance(billingFixture());
  expect(bare.balances).toHaveLength(1);

  const freeTier = parseBillingBalance({ code: 0, msg: "", data: { server_time: 1, plans: [], balances: [] } });
  expect(freeTier.plans).toEqual([]);
  expect(freeTier.balances).toEqual([]);

  const malformed = parseBillingBalance("not-json-object");
  expect(malformed.plans).toEqual([]);
  expect(malformed.balances).toEqual([]);
});

test("billingHeaders mirror the desktop billing-plane shape", () => {
  const headers = billingHeaders(
    { family: "zai", identity: "user-1", token: "jwt-value" },
    { deviceMid: "device-mid-1", appVersion: "3.18.2" }
  );
  expect(headers["User-Agent"]).toBe("ZCode/3.18.2");
  expect(headers["HTTP-Referer"]).toBe("https://zcode.z.ai");
  expect(headers["X-Title"]).toBe("Z Code@electron");
  expect(headers["X-ZCode-App-Version"]).toBe("3.18.2");
  expect(headers["X-Platform"]).toBe(process.platform);
  expect(headers["X-Release-Channel"]).toBe("stable");
  expect(headers["X-Os-Category"]).toBe(process.platform);
  expect(headers["X-Device-Mid"]).toBe("device-mid-1");
  expect(headers["Authorization"]).toBe("Bearer jwt-value");
  expect(headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
});

test("billingHeaders omit X-Device-Mid when the environment has none yet", () => {
  const headers = billingHeaders({ family: "zai", identity: "user-1", token: "jwt-value" });
  expect(headers["X-Device-Mid"]).toBeUndefined();
});

test("file credential reader decrypts enc:v2:env records from the isolated data dir", async () => {
  const { env } = isolatedEnv({
    ".zcode/v2/credentials.json": JSON.stringify({
      "oauth:active_provider": sealV2Env("zai"),
      "zcodejwttoken": sealV2Env(APP_JWT),
      "oauth:zai:user_info": sealV2Env(JSON.stringify({ user_id: "desktop-user" })),
      "account-provider:account:zai-individual-coding-plan:auth-source": sealV2Env("oauth")
    })
  });
  const store = createFileCredentialReader(env);
  const values = await store.loadMany(["oauth:active_provider", "zcodejwttoken", "oauth:zai:user_info", "missing"]);
  expect(values["oauth:active_provider"]).toBe("zai");
  expect(values["zcodejwttoken"]).toBe(APP_JWT);
  expect(values["oauth:zai:user_info"]).toBe(JSON.stringify({ user_id: "desktop-user" }));
  expect(values["missing"]).toBeNull();
});

test("file credential reader decrypts OS-keyring records without changing the login", async () => {
  const key = randomBytes(32);
  const { env } = isolatedEnv({
    ".zcode/v2/credentials.json": JSON.stringify({
      "oauth:active_provider": sealV2Os("zai", key),
      "zcodejwttoken": sealV2Os(APP_JWT, key),
      "oauth:zai:user_info": sealV2Os(JSON.stringify({ user_id: "desktop-user" }), key)
    })
  });
  let keyReads = 0;
  const store = createFileCredentialReader(env, {
    readOsKey: async () => {
      keyReads++;
      return key;
    }
  });
  const session = await readStartPlanSession(store);
  expect(session).toMatchObject({ family: "zai", identity: "desktop-user", token: APP_JWT });
  expect(keyReads).toBe(1);
});

test("file credential reader propagates unavailable OS credential storage", async () => {
  const key = randomBytes(32);
  const { env } = isolatedEnv({
    ".zcode/v2/credentials.json": JSON.stringify({
      "oauth:active_provider": sealV2Os("zai", key)
    })
  });
  const store = createFileCredentialReader(env, {
    readOsKey: async () => {
      throw Object.assign(new Error("keychain is locked"), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" });
    }
  });
  await expect(store.loadMany(["oauth:active_provider"])).rejects.toMatchObject({
    code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE"
  });
});

test("file credential reader returns nulls for unreadable or keyring-protected records", async () => {
  const { env } = isolatedEnv({
    ".zcode/v2/credentials.json": JSON.stringify({
      "zcodejwttoken": "enc:v2:env:deadbeef:aGVsbG8.AAAAAAAAAAAAAAAAAAAAAA.aGVsbG8",
      "plain": "plain-value",
      "broken": "enc:v2:env:not-a-valid-record"
    })
  });
  const values = await createFileCredentialReader(env).loadMany(["zcodejwttoken", "plain", "broken"]);
  expect(values["zcodejwttoken"]).toBeNull();
  expect(values["plain"]).toBe("plain-value");
  expect(values["broken"]).toBeNull();
});

test("file credential reader decrypts legacy enc:v1 records when a managed secret exists", async () => {
  const key = createHash("sha256").update(SECRET, "utf8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update("legacy-value", "utf8"), cipher.final()]);
  const legacy = `enc:v1:${[iv, cipher.getAuthTag(), bytes].map(part => part.toString("base64url")).join(".")}`;
  const { env } = isolatedEnv({ ".zcode/v2/credentials.json": JSON.stringify({ "zcodejwttoken": legacy }) });
  const values = await createFileCredentialReader(env).loadMany(["zcodejwttoken"]);
  expect(values["zcodejwttoken"]).toBe("legacy-value");
});

test("file credential reader feeds readStartPlanSession for the shared OAuth session", async () => {
  const { env } = isolatedEnv({
    ".zcode/v2/credentials.json": JSON.stringify({
      "oauth:active_provider": sealV2Env("zai"),
      "zcodejwttoken": sealV2Env(APP_JWT),
      "oauth:zai:user_info": sealV2Env(JSON.stringify({ user_id: "desktop-user" }))
    })
  });
  const session = await readStartPlanSession(createFileCredentialReader(env));
  expect(session).toMatchObject({ family: "zai", identity: "desktop-user", token: APP_JWT });
});

test("readDeviceMid reads the runtime-created telemetry state from the isolated dir", () => {
  const { env, dir } = isolatedEnv({ ".zcode/v2/telemetry-state.json": JSON.stringify({ deviceMid: "device-mid-42" }) });
  expect(readDeviceMid(env)).toBe("device-mid-42");
  expect(dir).toBeTruthy();
});

test("loadCurrentQuotaOverview returns the parsed overview through a mocked transport", async () => {
  const { env } = isolatedEnv({
    ".zcode/v2/credentials.json": JSON.stringify({
      "oauth:active_provider": sealV2Env("zai"),
      "zcodejwttoken": sealV2Env(APP_JWT),
      "oauth:zai:user_info": sealV2Env(JSON.stringify({ user_id: "desktop-user" }))
    }),
    ".zcode/v2/telemetry-state.json": JSON.stringify({ deviceMid: "device-mid-42" })
  });
  env.ZCODE_APP_VERSION = "3.19.1";
  let capturedHeaders: Record<string, string> | undefined;
  const fetchImpl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    capturedHeaders = init?.headers;
    return new Response(JSON.stringify(billingFixture()), { status: 200 });
  }) as unknown as typeof fetch;
  const result = await loadCurrentQuotaOverview({ env, fetchImpl });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.overview.plans[0]?.name).toBe("ZCODE WEEKEND BUILD");
  expect(result.overview.balances[0]?.remainingUnits).toBe(499799821);
  expect(capturedHeaders?.["X-Device-Mid"]).toBe("device-mid-42");
  expect(capturedHeaders?.["X-ZCode-App-Version"]).toBe("3.19.1");
  expect(capturedHeaders?.["Authorization"]).toBe(`Bearer ${APP_JWT}`);
});

test("loadCurrentQuotaOverview reports a missing OAuth session without calling the endpoint", async () => {
  const { env } = isolatedEnv({ ".zcode/v2/credentials.json": JSON.stringify({}) });
  let endpointCalled = false;
  const fetchImpl = (async () => {
    endpointCalled = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const result = await loadCurrentQuotaOverview({ env, fetchImpl });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("no-oauth-session");
  expect(endpointCalled).toBe(false);
});

test("loadCurrentQuotaOverview surfaces endpoint rejections as request failures", async () => {
  const { env } = isolatedEnv({
    ".zcode/v2/credentials.json": JSON.stringify({
      "oauth:active_provider": sealV2Env("zai"),
      "zcodejwttoken": sealV2Env(APP_JWT),
      "oauth:zai:user_info": sealV2Env(JSON.stringify({ user_id: "desktop-user" }))
    })
  });
  const fetchImpl = (async () => new Response(JSON.stringify({ code: 500, msg: "Z.ai user information is invalid" }), { status: 500 })) as unknown as typeof fetch;
  const result = await loadCurrentQuotaOverview({ env, fetchImpl });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("request-failed");
  expect(result.detail).toContain("Z.ai user information is invalid");
});

test("fetchQuotaOverview aborts requests that exceed the configured timeout", async () => {
  const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as unknown as typeof fetch;
  await expect(fetchQuotaOverview(
    { family: "zai", identity: "user-1", token: APP_JWT },
    { fetchImpl, timeoutMs: 5 }
  )).rejects.toThrow(/timed out/iu);
});
