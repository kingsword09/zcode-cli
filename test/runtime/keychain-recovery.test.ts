import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "acorn";
import { cacheCredentialKey } from "../../src/runtime-keychain-recovery.ts";
import { hasRuntimeKeychainRecovery, patchRuntimeKeychainRecovery } from "../../scripts/runtime-keychain-patches.ts";

const fixture = `
function nativeStore(file){let entry=async()=>keyring;return{async get(){try{return await(await entry()).getPassword()}catch{throw unavailable()}},async set(value){try{await(await entry()).setPassword(value)}catch{throw unavailable()}}}}
function nativeCipher(file){let cache=new Map;async function getKey(){let started=!1,pending=withLock(file,async()=>{started=!0;try{return"key"}catch{throw unavailable()}});return cache.set(file,pending),pending.catch(()=>{!started&&cache.get(file)===pending&&cache.delete(file)}),pending}return{getKey}}
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

test("nested fallback and copied-credential boundaries do not obscure the key lookup boundary", async () => {
  const copied = "async shareKeyWithCopiedCredentials(){await withLock(async()=>{try{throw copiedFailure}catch{throw unavailable()}})}";
  const updated = fixture.replace('return"key"', "try{return await lookup()}catch(error){if(!allowFallback)throw error;return fallback()}")
    .replace("return{getKey}", `return{getKey,${copied}}`);
  const patched = patchRuntimeKeychainRecovery(updated);
  expect(hasRuntimeKeychainRecovery(patched)).toBe(true);
  expect(patchRuntimeKeychainRecovery(patched)).toBe(patched);
  expect(patched).toContain(copied);
  expect(patched).toContain("catch(error){if(!allowFallback)throw error;return fallback()}");
  expect(() => parse(patched, { ecmaVersion: "latest" })).not.toThrow();

  const unavailable = () => new Error("credential unavailable");
  const secureError = Object.assign(new Error("unlock and retry"), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" });
  const makeCipher = (failure: Error, allowFallback: boolean) => new Function(
    "require", "__dirname", "withLock", "label", "unavailable", "lookup", "allowFallback", "fallback",
    `${patched};return nativeCipher("credentials")`
  )(
    (name: string) => name === "node:path" ? { join: () => "cli-config.cjs" } : { cacheCredentialKey },
    ".", (_file: string, callback: () => Promise<unknown>) => callback(), () => {}, unavailable,
    async () => { throw failure; }, allowFallback, () => "fallback-key"
  ) as { getKey(): Promise<string> };

  await expect(makeCipher(secureError, false).getKey()).rejects.toBe(secureError);
  await expect(makeCipher(new Error("native failure"), false).getKey()).rejects.toThrow("credential unavailable");
  await expect(makeCipher(new Error("native failure"), true).getKey()).resolves.toBe("fallback-key");
});

test("changed key lookup error contracts still fail closed", () => {
  for (const changed of [
    fixture.replace('return"key"}catch{throw unavailable()}', 'return"key"}catch{throw otherError()}'),
    fixture.replace('return"key"}catch{throw unavailable()}', 'return"key"}catch(error){throw error}')
  ]) {
    expect(() => patchRuntimeKeychainRecovery(changed)).toThrow("key lookup error boundary changed");
  }
});

test("changed or partially patched runtimes fail closed", async () => {
  const runtime = await readFile(new URL("../../vendor/zcode.cjs", import.meta.url), "utf8");
  const patched = patchRuntimeKeychainRecovery(runtime);
  const partial = patched.replace(".cacheCredentialKey(", ".missingCacheHandler(");
  expect(hasRuntimeKeychainRecovery(partial)).toBe(false);
  expect(() => patchRuntimeKeychainRecovery(partial)).toThrow("partial patch");
  expect(() => patchRuntimeKeychainRecovery("function incompatible(){}")).toThrow("label missing or ambiguous");
});
