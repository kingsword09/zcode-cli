import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "acorn";
import { hasRuntimeKeychainRecovery, patchRuntimeKeychainRecovery } from "../../scripts/runtime-keychain-patches.ts";

const runtime400 = `
function nativeStore(file){let entry, getEntry=async()=>keyring;return{async get(){return await(await getEntry()).getPassword()},async set(value){await(await getEntry()).setPassword(value)}}}
function nativeCipher(file){let c=new Map,v=!1,i=file,b=withFileLock(file,async()=>{try{return{generation:await readGeneration()}}catch(error){throw unavailable()}});return c.set(i,b),b.catch(k=>{!v&&c.get(i)===b&&c.delete(i)}),{getKey:async()=>{let key=await b;return key.generation===await readGeneration()?key:key}}}
label(nativeStore,"systemKeyStore");label(nativeCipher,"createSystemCredentialCipher");
const message="Unlock the OS credential store and restart to retry";
`;

test("4.0 keyring and cipher boundaries gain terminal recovery", () => {
  const patched = patchRuntimeKeychainRecovery(runtime400);
  expect(hasRuntimeKeychainRecovery(patched)).toBe(true);
  expect(patchRuntimeKeychainRecovery(patched)).toBe(patched);
  expect(patched).toContain(".createRecoverableSystemKeyStore(getEntry,");
  expect(patched).toContain("b.catch(k=>{c.get(i)===b&&c.delete(i)}");
  expect(patched).toContain('const message="Unlock the OS credential store and retry";');
  expect(() => parse(patched, { ecmaVersion: "latest" })).not.toThrow();
});

test("the current runtime supports an idempotent, verified keychain recovery patch", async () => {
  const runtime = await readFile(new URL("../../vendor/zcode.cjs", import.meta.url), "utf8");
  const patched = patchRuntimeKeychainRecovery(runtime);
  expect(hasRuntimeKeychainRecovery(patched)).toBe(true);
  expect(patchRuntimeKeychainRecovery(patched)).toBe(patched);
  expect(() => parse(patched, { ecmaVersion: "latest", allowReturnOutsideFunction: true })).not.toThrow();
});

test("changed 4.0 keyring APIs and partially patched runtimes fail closed", async () => {
  const changedApi = runtime400.replace("getPassword()", "getSecret()");
  expect(() => patchRuntimeKeychainRecovery(changedApi)).toThrow("4.0 system keyring API changed");
  const changedCache = runtime400.replace("!v&&c.get(i)===b&&c.delete(i)", "v&&c.get(i)===b&&c.delete(i)");
  expect(() => patchRuntimeKeychainRecovery(changedCache)).toThrow("4.0 credential cache recovery changed");

  const runtime = await readFile(new URL("../../vendor/zcode.cjs", import.meta.url), "utf8");
  const patched = patchRuntimeKeychainRecovery(runtime);
  const partial = patched.replace(".createRecoverableSystemKeyStore(", ".missingKeyStoreRecovery(");
  expect(hasRuntimeKeychainRecovery(partial)).toBe(false);
  expect(() => patchRuntimeKeychainRecovery(partial)).toThrow();
  expect(() => patchRuntimeKeychainRecovery("function incompatible(){}")).toThrow("label missing or ambiguous");
});
