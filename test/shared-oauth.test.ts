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

test("login cannot publish an OAuth token or project token as a business credential", () => {
  expect(zaiBusinessAccessToken({ zaiBusinessToken: " business-token " })).toBe("business-token");
  expect(() => zaiBusinessAccessToken({})).toThrow("business access token");
  expect(() => zaiBusinessAccessToken({ zaiBusinessToken: " " })).toThrow("business access token");
});
