import { expect, test } from "bun:test";
import { parse } from "acorn";
import { readFile } from "node:fs/promises";
import { hasRuntimeManagedCredentialSetup, patchRuntimeManagedCredentialSetup } from "../../scripts/runtime-credential-setup-patches.ts";

const fixture = `
function nativeLock(file,operation){return operation()}
const initLock=wrap(()=>{label(nativeLock,"withFileLock")});
function unavailable(){return Object.assign(new Error("System credential storage is unavailable. Old message"),{code:"CREDENTIAL_SECURE_STORAGE_UNAVAILABLE"})}
function nativeCipher(options){let lookup=async create=>"key";return{async initialize(){await lookup(!0)},async encrypt(value){let key=await lookup(!0);return value},async decrypt(value){return value}}}
const initCipher=wrap(()=>{initLock();label(unavailable,"unavailable");label(nativeCipher,"createSystemCredentialCipher")});
async function nativeLogin(options={}){await abortable(store.assertWritable(),signal);return authorize()}
label(nativeLogin,"loginZCodeCli");
const tui={submitPrompt:bridge,subscribeSessionEvents:bridge.subscribeSessionEvents};
async function main(){let args=process.argv.slice(2);return unrelated()}
`;

test("login recovery wraps only key writes and preflight, preserving OAuth and decryption", () => {
  const patched = patchRuntimeManagedCredentialSetup(fixture);
  expect(hasRuntimeManagedCredentialSetup(patched)).toBe(true);
  expect(patchRuntimeManagedCredentialSetup(patched)).toBe(patched);
  expect(patched).toContain('withLock:nativeLock');
  expect(patched).toContain('.withCredentialLogin({abortSignal:signal,confirmCredentialStorage:options.confirmCredentialStorage},()=>store.assertWritable())');
  expect(patched).toContain('.withCredentialLoginPrompt($zInput,$zOptions,()=>bridge($zInput,$zOptions))');
  expect(patched).toContain('async decrypt(value){return value}');
  expect(patched).toContain('return authorize()');
  expect(patched).toContain('.credentialStorageError(Object.assign(');
  expect(patched).toContain("return unrelated()");
  expect(() => parse(patched, { ecmaVersion: "latest" })).not.toThrow();
});

test("the actual runtime accepts the verified managed credential setup patch idempotently", async () => {
  const runtime = await readFile(new URL("../../vendor/zcode.cjs", import.meta.url), "utf8");
  const patched = patchRuntimeManagedCredentialSetup(runtime);
  expect(hasRuntimeManagedCredentialSetup(patched)).toBe(true);
  expect(patchRuntimeManagedCredentialSetup(patched)).toBe(patched);
  expect(() => parse(patched, { ecmaVersion: "latest", allowReturnOutsideFunction: true })).not.toThrow();
});

test("changed or partial credential setup contracts fail closed", () => {
  for (const changed of [
    fixture.replace('"withFileLock"', '"changedLock"'),
    fixture.replace("store.assertWritable()", "store.changedMethod()"),
    fixture.replace("await lookup(!0)", "await lookup(!1)"),
    fixture.replace("submitPrompt:bridge", "submitPrompt:changed"),
    fixture.replace("System credential storage is unavailable.", "Changed message."),
    fixture.replace("function unavailable(){", "function unavailable(){changed();")
  ]) {
    expect(() => patchRuntimeManagedCredentialSetup(changed)).toThrow("incompatible");
  }
  const partial = patchRuntimeManagedCredentialSetup(fixture).replace(".credentialStorageError(", ".changedError(");
  expect(hasRuntimeManagedCredentialSetup(partial)).toBe(false);
  expect(() => patchRuntimeManagedCredentialSetup(partial)).toThrow("partial patch");
});
