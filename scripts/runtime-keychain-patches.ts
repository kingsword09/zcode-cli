import { parseExpressionAt, type CatchClause, type FunctionExpression, type Node, type VariableDeclarator } from "acorn";

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

function keyLookupBoundary(cipher: FunctionExpression, pending: string, unavailable: string): CatchClause {
  const bindings: VariableDeclarator[] = [];
  const visit = (node: Node): void => {
    if (node.type === "VariableDeclarator") {
      const binding = node as VariableDeclarator;
      if (binding.id.type === "Identifier" && binding.id.name === pending) bindings.push(binding);
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && typeof child.type === "string") visit(child);
      }
    }
  };
  visit(cipher.body);
  if (bindings.length !== 1) incompatible("key lookup binding missing or ambiguous");
  const initializer = bindings[0]!.init;
  if (initializer?.type !== "CallExpression" || initializer.arguments.length !== 2) incompatible("key lookup lock changed");
  const callback = initializer.arguments[1];
  if (callback?.type !== "ArrowFunctionExpression" || !callback.async || callback.body.type !== "BlockStatement") {
    incompatible("key lookup callback changed");
  }
  const boundaries = callback.body.body.filter(statement => statement.type === "TryStatement");
  if (boundaries.length !== 1 || boundaries[0]?.type !== "TryStatement") incompatible("key lookup error boundary changed");
  const boundary = boundaries[0].handler;
  const failure = boundary?.body.body[0];
  if (!boundary || boundary.param || boundary.body.body.length !== 1 || failure?.type !== "ThrowStatement"
    || failure.argument.type !== "CallExpression" || failure.argument.callee.type !== "Identifier"
    || failure.argument.callee.name !== unavailable || failure.argument.arguments.length !== 0) {
    incompatible("key lookup error boundary changed");
  }
  return boundary;
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
  const boundary = keyLookupBoundary(cipher, cache[3]!, methods[2]!);
  const edits = [
    { start: storeReturn.start, end: storeReturn.end, value: `return ${helper}.createRecoverableSystemKeyStore(${methods[1]},${methods[2]})` },
    { start: cipher.start + cache.index!, end: cipher.start + cache.index! + cache[0].length,
      value: `return ${helper}.cacheCredentialKey(${cache[1]},${cache[2]},${cache[3]})` },
    { start: boundary.start, end: boundary.end,
      value: `catch($zCredentialError){if($zCredentialError?.code==="CREDENTIAL_SECURE_STORAGE_UNAVAILABLE")throw $zCredentialError;throw ${methods[2]}()}` }
  ];
  let patched = runtime;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    patched = patched.slice(0, edit.start) + edit.value + patched.slice(edit.end);
  }
  patched = patched.replace("Unlock the OS credential store and restart to retry", "Unlock the OS credential store and retry");
  if (!hasRuntimeKeychainRecovery(patched)) incompatible("postcondition failed");
  return patched;
}
