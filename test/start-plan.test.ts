import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readStartPlanSession, refreshStandaloneStartPlanRequest } from "../src/start-plan.ts";

const token = (claims: unknown = { exp: Math.floor(Date.now() / 1000) + 3600 }) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-signature`;
const input = { providerId: "account:zai-start-plan", accountAccess: { mode: "start-plan", accountType: "zai" } };

function fixture(family = "zai") {
  const values: Record<string, string | null> = {
    "oauth:active_provider": family,
    [`oauth:${family}:user_info`]: JSON.stringify({ user_id: "desktop-user" }),
    zcodejwttoken: token(),
  };
  const reads: string[][] = [];
  let onRead: (() => void) | undefined;
  const store = { async loadMany(keys: string[]) {
    reads.push(keys);
    onRead?.();
    return Object.fromEntries(keys.map(key => [key, values[key] ?? null]));
  } };
  return { values, reads, store, setReadHook(hook: typeof onRead) { onRead = hook; } };
}

test.each(["zai", "bigmodel"])("%s Start Plan uses the shared JWT without Coding Plan credentials", async family => {
  const f = fixture(family);
  const result = await refreshStandaloneStartPlanRequest(f.store, {
    providerId: `account:${family}-start-plan`, accountAccess: { mode: "start-plan", accountType: family },
  });
  expect(result).toEqual({ headersApplied: true, requestAuth: { apiKey: f.values.zcodejwttoken!, accountScope: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
  expect(f.reads.flat()).not.toContain(`oauth:${family}:access_token`);
  expect(f.reads.flat().some(key => key.startsWith("account-provider:"))).toBe(false);
});

test("a Bearer-prefixed stored JWT is normalized", async () => {
  const f = fixture(), jwt = f.values.zcodejwttoken;
  f.values.zcodejwttoken = ` Bearer ${jwt} `;
  expect((await refreshStandaloneStartPlanRequest(f.store, input)).requestAuth.apiKey).toBe(jwt!);
});

test("a ZCode session JWT without optional time claims remains usable", async () => {
  const f = fixture();
  f.values.zcodejwttoken = token({ sub: "desktop-user" });
  expect(await readStartPlanSession(f.store)).toEqual({ family: "zai", identity: "desktop-user", token: f.values.zcodejwttoken });
  expect((await refreshStandaloneStartPlanRequest(f.store, input)).requestAuth.apiKey).toBe(f.values.zcodejwttoken!);
});

test.each([null, "", "project-token", "a.invalid.c", token({ exp: 1 }), token(null), token([]), token("claims"),
  token({ exp: null }), token({ exp: "9999999999" }),
  token({ exp: 9999999999, nbf: 9999999998 })])("missing, malformed or expired JWT fails closed (%s)", async jwt => {
  const f = fixture();
  f.values.zcodejwttoken = jwt;
  f.values["oauth:zai:access_token"] = "coding-plan-business-token";
  expect(await readStartPlanSession(f.store)).toBeUndefined();
  await expect(refreshStandaloneStartPlanRequest(f.store, input)).rejects.toThrow("start_plan_login_required");
});

test.each([null, "{", "{}", '{"user_id":""}'])("an invalid profile cannot reuse a stale CLI identity (%s)", async profile => {
  const f = fixture();
  f.values["oauth:zai:user_info"] = profile;
  f.values["account-provider:account:zai-individual-coding-plan:identity"] = "old-cli-user";
  await expect(refreshStandaloneStartPlanRequest(f.store, input)).rejects.toThrow("start_plan_login_required");
});

test("only the active OAuth family's session can authorize Start Plan", async () => {
  const f = fixture("bigmodel");
  f.values["oauth:zai:user_info"] = JSON.stringify({ user_id: "old-zai-user" });
  await expect(refreshStandaloneStartPlanRequest(f.store, input)).rejects.toThrow("start_plan_login_required");
  expect(f.reads.flat()).not.toContain("oauth:zai:user_info");
});

test("no active OAuth family means no Start Plan even if stale credentials remain", async () => {
  const f = fixture();
  delete f.values["oauth:active_provider"];
  await expect(refreshStandaloneStartPlanRequest(f.store, input)).rejects.toThrow("start_plan_login_required");
  expect(f.reads).toEqual([["oauth:active_provider"]]);
});

test.each(["oauth:active_provider", "oauth:zai:user_info", "zcodejwttoken"])("a concurrent session change invalidates the snapshot (%s)", async key => {
  const f = fixture();
  f.setReadHook(() => { if (f.reads.length === 3) f.values[key] = null; });
  await expect(refreshStandaloneStartPlanRequest(f.store, input)).rejects.toThrow("start_plan_login_required");
});

test("each request rereads the session, and an in-flight retry cannot change account or JWT", async () => {
  const f = fixture();
  const first = await refreshStandaloneStartPlanRequest(f.store, input);
  f.values["oauth:zai:user_info"] = JSON.stringify({ user_id: "new-desktop-user" });
  f.values.zcodejwttoken = token({ exp: Math.floor(Date.now() / 1000) + 7200 });
  const second = await refreshStandaloneStartPlanRequest(f.store, input);
  expect(second.requestAuth.accountScope).not.toBe(first.requestAuth.accountScope);
  expect(second.requestAuth.apiKey).toBe(f.values.zcodejwttoken!);
  await expect(refreshStandaloneStartPlanRequest(f.store, { ...input, expectedAccountScope: first.requestAuth.accountScope })).rejects.toThrow("project_token_scope_invalidated");
  delete f.values["oauth:active_provider"];
  await expect(refreshStandaloneStartPlanRequest(f.store, { ...input, expectedAccountScope: second.requestAuth.accountScope })).rejects.toThrow("project_token_scope_invalidated");
});

test("a rejected JWT is not silently reused or replaced by a paid-plan key", async () => {
  const f = fixture();
  const first = await refreshStandaloneStartPlanRequest(f.store, input);
  const rejectedProjectTokenFingerprint = createHash("sha256").update(first.requestAuth.apiKey).digest("hex");
  await expect(refreshStandaloneStartPlanRequest(f.store, { ...input, rejectedProjectTokenFingerprint })).rejects.toThrow("project_token_scope_invalidated");
  await expect(refreshStandaloneStartPlanRequest(f.store, {
    ...input, expectedAccountScope: first.requestAuth.accountScope, rejectedProjectTokenFingerprint,
  })).rejects.toThrow("start_plan_session_rejected");
});

test.each([0, 1, 2, 3])("cancellation stops credential reads at step %s", async step => {
  const f = fixture(), controller = new AbortController();
  if (step === 0) controller.abort();
  else f.setReadHook(() => { if (f.reads.length === step) controller.abort(); });
  await expect(refreshStandaloneStartPlanRequest(f.store, { ...input, abortSignal: controller.signal })).rejects.toThrow();
  expect(f.reads).toHaveLength(step);
});

test("credential read errors do not become an authorization fallback", async () => {
  await expect(refreshStandaloneStartPlanRequest({ async loadMany() { throw new Error("decrypt failed"); } }, input)).rejects.toThrow("decrypt failed");
});

test("the helper cannot authorize an unrelated access mode or family", async () => {
  const f = fixture();
  for (const accountAccess of [{ mode: "individual-coding-plan", accountType: "zai" }, { mode: "start-plan", accountType: "unknown" }]) {
    await expect(refreshStandaloneStartPlanRequest(f.store, { ...input, accountAccess })).rejects.toThrow("start_plan_account_required");
  }
  await expect(refreshStandaloneStartPlanRequest(f.store, { ...input, providerId: "custom-provider" })).rejects.toThrow("start_plan_account_required");
  await expect(refreshStandaloneStartPlanRequest(f.store, { ...input, providerId: "account:bigmodel-start-plan" })).rejects.toThrow("start_plan_account_required");
  expect(f.reads).toHaveLength(0);
});
