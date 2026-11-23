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

function hasNativeCacheRecovery(source: string): boolean {
  return source.includes("generation===await") && source.includes("S.catch(") && source.includes("c.delete(i)");
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
    incompatible("3.19 system keyring API changed");
  }
  if (!hasNativeCacheRecovery(runtime.slice(cipher.start, cipher.end))) {
    incompatible("3.19 credential cache recovery changed");
  }

  const unavailable = '()=>Object.assign(new Error("System credential storage is unavailable."),{code:"CREDENTIAL_SECURE_STORAGE_UNAVAILABLE"})';
  let patched = runtime.slice(0, storeReturn.start)
    + `return ${helper}.createRecoverableSystemKeyStore(${getter},${unavailable})`
    + runtime.slice(storeReturn.end);
  patched = patched.replace("Unlock the OS credential store and restart to retry", "Unlock the OS credential store and retry");
  if (!hasRuntimeKeychainRecovery(patched)) incompatible("postcondition failed");
  return patched;
}
