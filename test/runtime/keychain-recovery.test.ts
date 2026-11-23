import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "acorn";
import { hasRuntimeKeychainRecovery, patchRuntimeKeychainRecovery } from "../../scripts/runtime-keychain-patches.ts";

const runtime319 = `
function nativeStore(file){let entry, getEntry=async()=>keyring;return{async get(){return await(await getEntry()).getPassword()},async set(value){await(await getEntry()).setPassword(value)}}}
function nativeCipher(file){let c=new Map;async function getKey(){let started=!1,i=file,S=Promise.resolve({generation:await readGeneration()});return S.generation===await readGeneration()?S:(c.set(i,S),S.catch(k=>{!started&&c.get(i)===S&&c.delete(i)}),S)}return{getKey}}
label(nativeStore,"systemKeyStore");label(nativeCipher,"createSystemCredentialCipher");
const message="Unlock the OS credential store and restart to retry";
`;

test("3.19 keyring and cipher boundaries gain terminal recovery", () => {
  const patched = patchRuntimeKeychainRecovery(runtime319);
  expect(hasRuntimeKeychainRecovery(patched)).toBe(true);
  expect(patchRuntimeKeychainRecovery(patched)).toBe(patched);
  expect(patched).toContain(".createRecoverableSystemKeyStore(getEntry,");
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

test("changed 3.19 keyring APIs and partially patched runtimes fail closed", async () => {
  const changedApi = runtime319.replace("getPassword()", "getSecret()");
  expect(() => patchRuntimeKeychainRecovery(changedApi)).toThrow("3.19 system keyring API changed");
  const changedCache = runtime319.replace("generation===await", "generation!==await");
  expect(() => patchRuntimeKeychainRecovery(changedCache)).toThrow("3.19 credential cache recovery changed");

  const runtime = await readFile(new URL("../../vendor/zcode.cjs", import.meta.url), "utf8");
  const patched = patchRuntimeKeychainRecovery(runtime);
  const partial = patched.replace(".createRecoverableSystemKeyStore(", ".missingKeyStoreRecovery(");
  expect(hasRuntimeKeychainRecovery(partial)).toBe(false);
  expect(() => patchRuntimeKeychainRecovery(partial)).toThrow();
  expect(() => patchRuntimeKeychainRecovery("function incompatible(){}")).toThrow("label missing or ambiguous");
});
