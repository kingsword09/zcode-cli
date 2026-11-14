import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "acorn";
import { hasRuntimeKeychainRecovery, patchRuntimeKeychainRecovery } from "../../scripts/runtime-keychain-patches.ts";

const fixture = `
function nativeStore(file){let entry=async()=>keyring;return{async get(){try{return await(await entry()).getPassword()}catch{throw unavailable()}},async set(value){try{await(await entry()).setPassword(value)}catch{throw unavailable()}}}}
function nativeCipher(file){let cache=new Map;async function getKey(){let started=!1,pending=withLock(async()=>{started=!0;try{return"key"}catch{throw unavailable()}});return cache.set(file,pending),pending.catch(()=>{!started&&cache.get(file)===pending&&cache.delete(file)}),pending}return{getKey}}
label(nativeStore,"systemKeyStore");label(nativeCipher,"createSystemCredentialCipher");
const message="Unlock the OS credential store and restart to retry";
`;

test("unpatched keyring and cipher boundaries gain recovery without changing unrelated code", () => {
  const patched = patchRuntimeKeychainRecovery(fixture);
  expect(hasRuntimeKeychainRecovery(patched)).toBe(true);
  expect(patchRuntimeKeychainRecovery(patched)).toBe(patched);
  expect(patched).toContain(".createRecoverableSystemKeyStore(entry,unavailable)");
  expect(patched).toContain(".cacheCredentialKey(cache,file,pending)");
  expect(patched).toContain('const message="Unlock the OS credential store and retry";');
  expect(() => parse(patched, { ecmaVersion: "latest" })).not.toThrow();
  expect(() => patchRuntimeKeychainRecovery(fixture.replace(".getPassword()", ".changedMethod()"))).toThrow("native keyring methods changed");
  expect(() => patchRuntimeKeychainRecovery(fixture.replace("!started&&", ""))).toThrow("key cache failure handler changed");
});

test("the actual runtime supports an idempotent, verified keychain recovery patch", async () => {
  const runtime = await readFile(new URL("../../vendor/zcode.cjs", import.meta.url), "utf8");
  const patched = patchRuntimeKeychainRecovery(runtime);
  expect(hasRuntimeKeychainRecovery(patched)).toBe(true);
  expect(patchRuntimeKeychainRecovery(patched)).toBe(patched);
  expect(() => parse(patched, { ecmaVersion: "latest", allowReturnOutsideFunction: true })).not.toThrow();
});

test("changed or partially patched runtimes fail closed", async () => {
  const runtime = await readFile(new URL("../../vendor/zcode.cjs", import.meta.url), "utf8");
  const patched = patchRuntimeKeychainRecovery(runtime);
  const partial = patched.replace(".cacheCredentialKey(", ".missingCacheHandler(");
  expect(hasRuntimeKeychainRecovery(partial)).toBe(false);
  expect(() => patchRuntimeKeychainRecovery(partial)).toThrow("partial patch");
  expect(() => patchRuntimeKeychainRecovery("function incompatible(){}")).toThrow("label missing or ambiguous");
});
