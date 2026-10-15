import { expect, test } from "bun:test";
import { sharedOAuthCredentialReader, zaiBusinessAccessToken } from "../src/shared-oauth.ts";

const zai = "account:zai-individual-coding-plan", bigmodel = "account:bigmodel-individual-coding-plan";
const identity = (id: string) => `account-provider:${id}:identity`;
const source = (id: string) => `account-provider:${id}:auth-source`;
const catalog = async () => [{ providerId: zai, family: "zai" }, { providerId: bigmodel, family: "bigmodel" }];

function fixture(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  const reads: string[][] = [];
  const store = { async loadMany(keys: string[]) {
    reads.push(keys);
    if (keys.some(key => values[key] === "corrupt")) throw new Error("decrypt failed");
    return Object.fromEntries(keys.map(key => [key, values[key] ?? null]));
  } };
  return { values, reads, reader: sharedOAuthCredentialReader(store, catalog) };
}

test("Desktop's active profile supplies the standalone identity without CLI login markers", async () => {
  const f = fixture({ "oauth:active_provider": "zai", "oauth:zai:user_info": JSON.stringify({ user_id: "desktop-user" }),
    [identity(zai)]: "corrupt" });
  expect(await f.reader.loadMany([identity(zai), identity(bigmodel)])).toEqual({ [identity(zai)]: "desktop-user", [identity(bigmodel)]: null });
  expect(f.values[identity(zai)]).toBe("corrupt");
  f.values["oauth:zai:user_info"] = JSON.stringify({ id: "new-user", username: "User", displayName: "User" });
  expect(await f.reader.load(identity(zai))).toBe("new-user");
  f.values["oauth:zai:user_info"] = JSON.stringify({ id: "normalized-user", rawProfile: { user_id: "raw-user" } });
  expect(await f.reader.load(identity(zai))).toBe("normalized-user");
  delete f.values["oauth:active_provider"];
  expect(await f.reader.load(identity(zai))).toBeNull();
});

test("an explicit manual key remains usable without decrypting unrelated OAuth credentials", async () => {
  const f = fixture({ [source(zai)]: "manual", [identity(zai)]: "manual-user", "oauth:active_provider": "corrupt" });
  expect(await f.reader.load(identity(zai))).toBe("manual-user");
  expect(f.reads.flat()).not.toContain("oauth:active_provider");
});

test("switching the active platform disconnects stale OAuth markers from the previous platform", async () => {
  const f = fixture({ "oauth:active_provider": "bigmodel", "oauth:bigmodel:user_info": JSON.stringify({ id: "bigmodel-user" }),
    [source(zai)]: "oauth", [identity(zai)]: "old-zai-user", "oauth:zai:user_info": "corrupt" });
  expect(await f.reader.loadMany([identity(zai), identity(bigmodel)])).toEqual({ [identity(zai)]: null, [identity(bigmodel)]: "bigmodel-user" });
  expect(f.reads.flat()).not.toContain("oauth:zai:user_info");
});

test("a missing or malformed profile cannot reuse a stale CLI identity", async () => {
  const f = fixture({ "oauth:active_provider": "zai", [identity(zai)]: "old-user" });
  for (const value of ["", "{", "{}", '{"user_id":42}', '{"user_id":" "}']) {
    f.values["oauth:zai:user_info"] = value;
    expect(await f.reader.load(identity(zai))).toBeNull();
  }
});

test("unrelated credential reads retain the native store contract", async () => {
  const f = fixture({ "mcp:test": "value", "account-provider:custom:identity": "custom-user" });
  expect(await f.reader.loadMany(["mcp:test", "missing", "account-provider:custom:identity"]))
    .toEqual({ "mcp:test": "value", missing: null, "account-provider:custom:identity": "custom-user" });
  expect(f.reads).toHaveLength(1);
});

test("login cannot publish an OAuth token or project token as a business credential", () => {
  expect(zaiBusinessAccessToken({ zaiBusinessToken: " business-token " })).toBe("business-token");
  expect(() => zaiBusinessAccessToken({})).toThrow("business access token");
  expect(() => zaiBusinessAccessToken({ zaiBusinessToken: " " })).toThrow("business access token");
});
