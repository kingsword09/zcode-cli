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

function modernStoreGetter(source: string): string | undefined {
  return new RegExp(`async get\\(\\)\\{return await\\(await (${identifier})\\(\\)\\)\\.getPassword\\(\\)\\}`, "u").exec(source)?.[1];
}

const failedKeyLookupMarker = "!v&&c.get(i)===b&&c.delete(i)";
const recoveredKeyLookupMarker = "c.get(i)===b&&c.delete(i)";

function hasNativeCacheRecovery(source: string): boolean {
  return source.includes("generation===await") && source.includes("b.catch(")
    && source.includes(recoveredKeyLookupMarker) && !source.includes(failedKeyLookupMarker);
}

export function hasRuntimeKeychainRecovery(runtime: string): boolean {
  try {
    const store = namedFunction(runtime, "systemKeyStore");
    const cipher = namedFunction(runtime, "createSystemCredentialCipher");
    const storeSource = runtime.slice(store.start, store.end);
    const cipherSource = runtime.slice(cipher.start, cipher.end);
    return storeSource.includes(`${helper}.createRecoverableSystemKeyStore(`)
      && hasNativeCacheRecovery(cipherSource)
      && !runtime.includes("Unlock the OS credential store and restart to retry");
  } catch { return false; }
}

export function patchRuntimeKeychainRecovery(runtime: string): string {
  if (hasRuntimeKeychainRecovery(runtime)) return runtime;
  if (runtime.includes(".createRecoverableSystemKeyStore(")) incompatible("partial patch");

  const store = namedFunction(runtime, "systemKeyStore");
  const cipher = namedFunction(runtime, "createSystemCredentialCipher");
  const storeSource = runtime.slice(store.start, store.end);
  const storeReturn = store.body.body.at(-1);
  const getter = modernStoreGetter(storeSource);
  const setter = getter && new RegExp(`async set\\((${identifier})\\)\\{await\\(await ${getter}\\(\\)\\)\\.setPassword\\(\\1\\)\\}`, "u").exec(storeSource);
  if (storeReturn?.type !== "ReturnStatement" || !getter || !setter) {
    incompatible("4.0 system keyring API changed");
  }
  const cipherSource = runtime.slice(cipher.start, cipher.end);
  if (!cipherSource.includes("generation===await") || !cipherSource.includes("b.catch(")
    || cipherSource.split(failedKeyLookupMarker).length !== 2) {
    incompatible("4.0 credential cache recovery changed");
  }

  const unavailable = '()=>Object.assign(new Error("System credential storage is unavailable."),{code:"CREDENTIAL_SECURE_STORAGE_UNAVAILABLE"})';
  let patched = runtime.replace(failedKeyLookupMarker, recoveredKeyLookupMarker);
  const patchedStore = namedFunction(patched, "systemKeyStore");
  const patchedReturn = patchedStore.body.body.at(-1);
  if (patchedReturn?.type !== "ReturnStatement") incompatible("4.0 system keyring API changed");
  patched = patched.slice(0, patchedReturn.start)
    + `return ${helper}.createRecoverableSystemKeyStore(${getter},${unavailable})`
    + patched.slice(patchedReturn.end);
  patched = patched.replace("Unlock the OS credential store and restart to retry", "Unlock the OS credential store and retry");
  if (!hasRuntimeKeychainRecovery(patched)) incompatible("postcondition failed");
  return patched;
}
