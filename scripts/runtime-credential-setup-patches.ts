import { parseExpressionAt, type FunctionExpression, type Node } from "acorn";

const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';
const marker = `${helper}.recoverCredentialKey(`;

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with login credential recovery (${detail}).`);
}

function namedFunction(runtime: string, label: string, source?: string): FunctionExpression {
  const labels = [...runtime.matchAll(new RegExp(`[A-Za-z_$][\\w$]*\\(([A-Za-z_$][\\w$]*),"${label}"\\)`, "gu"))];
  const candidates = labels.map(match => {
    const declarations = [...runtime.matchAll(new RegExp(`(?:async )?function ${match[1]!.replace(/[$]/gu, "\\$")}\\(`, "gu"))];
    if (declarations.length !== 1) incompatible(`${label} declaration missing or ambiguous`);
    const declaration = parseExpressionAt(runtime, declarations[0]!.index!, { ecmaVersion: "latest" });
    if (declaration.type !== "FunctionExpression") incompatible(`${label} signature changed`);
    return declaration;
  }).filter(declaration => !source || runtime.slice(declaration.start, declaration.end).includes(source));
  if (candidates.length !== 1) incompatible(`${label} label missing or ambiguous`);
  return candidates[0]!;
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === "object" && typeof child.type === "string") walk(child, visit);
    }
  }
}

function errorExpression(runtime: string) {
  const unavailable = namedFunction(runtime, "unavailable", "System credential storage is unavailable.");
  const returned = unavailable.body.body[0];
  if (unavailable.body.body.length !== 1 || returned?.type !== "ReturnStatement" || !returned.argument) {
    incompatible("secure storage error contract changed");
  }
  return returned.argument;
}

export function hasRuntimeManagedCredentialSetup(runtime: string): boolean {
  try {
    const cipher = namedFunction(runtime, "createSystemCredentialCipher");
    const login = namedFunction(runtime, "loginZCodeCli");
    const error = errorExpression(runtime);
    const source = runtime.slice(cipher.start, cipher.end);
    return source.split(marker).length === 3
      && runtime.slice(login.start, login.end).includes(`${helper}.withCredentialLogin(`)
      && runtime.includes(`submitPrompt:($zInput,$zOptions)=>${helper}.withCredentialLoginPrompt(`)
      && runtime.slice(error.start, error.end).startsWith(`${helper}.credentialStorageError(`);
  } catch { return false; }
}

export function patchRuntimeManagedCredentialSetup(runtime: string): string {
  if (hasRuntimeManagedCredentialSetup(runtime)) return runtime;
  if (runtime.includes(marker) || runtime.includes(`${helper}.credentialStorageError(`)) incompatible("partial patch");
  const cipher = namedFunction(runtime, "createSystemCredentialCipher");
  const lock = namedFunction(runtime, "withFileLock");
  const login = namedFunction(runtime, "loginZCodeCli");
  const error = errorExpression(runtime);
  const cipherOptions = cipher.params[0];
  const loginOptions = login.params[0];
  if (cipherOptions?.type !== "Identifier" || loginOptions?.type !== "AssignmentPattern"
    || loginOptions.left.type !== "Identifier") incompatible("credential options changed");
  const returned = cipher.body.body.at(-1);
  if (returned?.type !== "ReturnStatement" || returned.argument?.type !== "ObjectExpression") incompatible("cipher methods changed");
  const edits: { start: number; end: number; value: string }[] = [];
  for (const name of ["initialize", "encrypt"]) {
    const method = returned.argument.properties.find(property => property.type === "Property" && property.key.type === "Identifier" && property.key.name === name);
    if (method?.type !== "Property" || method.value.type !== "FunctionExpression") incompatible(`${name} method changed`);
    const lookups: Node[] = [];
    walk(method.value.body, node => {
      if (node.type === "AwaitExpression" && /^await [A-Za-z_$][\w$]*\(!0\)$/u.test(runtime.slice(node.start, node.end))) lookups.push(node);
    });
    if (lookups.length !== 1) incompatible(`${name} key lookup changed`);
    const lookup = lookups[0]!;
    const operation = runtime.slice(lookup.start + "await ".length, lookup.end);
    edits.push({ start: lookup.start, end: lookup.end,
      value: `await ${marker}()=>${operation},{filePath:${cipherOptions.name}.filePath,env:${cipherOptions.name}.env,withLock:${lock.id!.name}})` });
  }
  const loginSource = runtime.slice(login.start, login.end);
  const writable = [...loginSource.matchAll(/([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*\.assertWritable\(\)),([A-Za-z_$][\w$]*)\)/gu)];
  if (writable.length !== 1) incompatible("login storage preflight changed");
  const preflight = writable[0]!;
  const start = login.start + preflight.index!;
  edits.push({ start, end: start + preflight[0].length,
    value: `${preflight[1]}(${helper}.withCredentialLogin({abortSignal:${preflight[3]},confirmCredentialStorage:${loginOptions.left.name}.confirmCredentialStorage},()=>${preflight[2]}),${preflight[3]})` });
  const tui = [...runtime.matchAll(/submitPrompt:([A-Za-z_$][\w$]*),subscribeSessionEvents:\1\.subscribeSessionEvents/gu)];
  if (tui.length !== 1) incompatible("TUI login adapter changed");
  const adapter = tui[0]!;
  edits.push({ start: adapter.index!, end: adapter.index! + `submitPrompt:${adapter[1]}`.length,
    value: `submitPrompt:($zInput,$zOptions)=>${helper}.withCredentialLoginPrompt($zInput,$zOptions,()=>${adapter[1]}($zInput,$zOptions))` });
  edits.push({ start: error.start, end: error.end, value: `${helper}.credentialStorageError(${runtime.slice(error.start, error.end)})` });
  for (const edit of edits.sort((first, second) => second.start - first.start)) {
    runtime = runtime.slice(0, edit.start) + edit.value + runtime.slice(edit.end);
  }
  if (!hasRuntimeManagedCredentialSetup(runtime)) incompatible("postcondition failed");
  return runtime;
}
