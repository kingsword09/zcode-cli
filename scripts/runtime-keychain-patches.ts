import { parseExpressionAt, type FunctionExpression } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";
const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with terminal keychain recovery (${detail}).`);
}

function namedFunction(runtime: string, label: string): FunctionExpression {
  const labels = [...runtime.matchAll(new RegExp(`${identifier}\\((${identifier}),"${label}"\\)`, "gu"))];
  if (labels.length !== 1) incompatible(`${label} label missing or ambiguous`);
  const name = labels[0]![1]!.replace(/[$]/gu, "\\$");
  const declarations = [...runtime.matchAll(new RegExp(`function ${name}\\(`, "gu"))];
  if (declarations.length !== 1) incompatible(`${label} declaration missing or ambiguous`);
  const declaration = parseExpressionAt(runtime, declarations[0]!.index!, { ecmaVersion: "latest" });
  if (declaration.type !== "FunctionExpression") incompatible(`${label} signature changed`);
  return declaration;
}

export function hasRuntimeKeychainRecovery(runtime: string): boolean {
  try {
    const store = namedFunction(runtime, "systemKeyStore");
    const cipher = namedFunction(runtime, "createSystemCredentialCipher");
    return runtime.slice(store.start, store.end).includes(`${helper}.createRecoverableSystemKeyStore(`)
      && runtime.slice(cipher.start, cipher.end).includes(`${helper}.cacheCredentialKey(`)
      && runtime.slice(cipher.start, cipher.end).includes('catch($zCredentialError){if($zCredentialError?.code==="CREDENTIAL_SECURE_STORAGE_UNAVAILABLE")throw $zCredentialError;')
      && !runtime.includes("Unlock the OS credential store and restart to retry");
  } catch { return false; }
}

export function patchRuntimeKeychainRecovery(runtime: string): string {
  if (hasRuntimeKeychainRecovery(runtime)) return runtime;
  if (runtime.includes(".createRecoverableSystemKeyStore(") || runtime.includes(".cacheCredentialKey(")) incompatible("partial patch");
  const store = namedFunction(runtime, "systemKeyStore");
  const cipher = namedFunction(runtime, "createSystemCredentialCipher");
  const storeSource = runtime.slice(store.start, store.end);
  const storeReturn = store.body.body.at(-1);
  const methods = new RegExp(`return\\{async get\\(\\)\\{try\\{return await\\(await (${identifier})\\(\\)\\)\\.getPassword\\(\\)\\}catch\\{throw (${identifier})\\(\\)\\}\\},async set\\((${identifier})\\)\\{try\\{await\\(await \\1\\(\\)\\)\\.setPassword\\(\\3\\)\\}catch\\{throw \\2\\(\\)\\}\\}\\}$`, "u").exec(storeSource.slice(0, -1));
  if (storeReturn?.type !== "ReturnStatement" || !methods) incompatible("native keyring methods changed");
  const cipherSource = runtime.slice(cipher.start, cipher.end);
  const cachePattern = new RegExp(`return (${identifier})\\.set\\((${identifier}),(${identifier})\\),\\3\\.catch\\(\\(\\)=>\\{!${identifier}&&\\1\\.get\\(\\2\\)===\\3&&\\1\\.delete\\(\\2\\)\\}\\),\\3`, "gu");
  const caches = [...cipherSource.matchAll(cachePattern)];
  if (caches.length !== 1) incompatible("key cache failure handler changed");
  const cache = caches[0]!;
  const failures = [...cipherSource.matchAll(new RegExp(`\\}catch\\{throw (${identifier})\\(\\)\\}\\}\\)`, "gu"))];
  if (failures.length !== 1) incompatible("key lookup error boundary changed");
  const failure = failures[0]!;
  const edits = [
    { start: storeReturn.start, end: storeReturn.end, value: `return ${helper}.createRecoverableSystemKeyStore(${methods[1]},${methods[2]})` },
    { start: cipher.start + cache.index!, end: cipher.start + cache.index! + cache[0].length,
      value: `return ${helper}.cacheCredentialKey(${cache[1]},${cache[2]},${cache[3]})` },
    { start: cipher.start + failure.index!, end: cipher.start + failure.index! + failure[0].length,
      value: `}catch($zCredentialError){if($zCredentialError?.code==="CREDENTIAL_SECURE_STORAGE_UNAVAILABLE")throw $zCredentialError;throw ${failure[1]}()}})` }
  ];
  let patched = runtime;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    patched = patched.slice(0, edit.start) + edit.value + patched.slice(edit.end);
  }
  patched = patched.replace("Unlock the OS credential store and restart to retry", "Unlock the OS credential store and retry");
  if (!hasRuntimeKeychainRecovery(patched)) incompatible("postcondition failed");
  return patched;
}
