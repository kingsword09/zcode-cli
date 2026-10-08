import { parseExpressionAt, type FunctionExpression, type Node, type VariableDeclarator } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";
const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with BigModel OAuth (${detail}).`);
}

function unique<T>(values: T[], anchor: string): T {
  if (values.length !== 1) incompatible(`${anchor} missing or ambiguous`);
  return values[0]!;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function symbol(runtime: string, label: string): string {
  return unique([...runtime.matchAll(new RegExp(`${identifier}\\((${identifier}),"${label}"\\)`, "gu"))], label)[1]!;
}

function namedFunction(runtime: string, label: string): FunctionExpression {
  const name = symbol(runtime, label);
  const match = unique([...runtime.matchAll(new RegExp(`(?:async )?function ${escape(name)}\\(`, "gu"))], label);
  const fn = parseExpressionAt(runtime, match.index!, { ecmaVersion: "latest" });
  if (fn.type !== "FunctionExpression" || fn.id?.name !== name) incompatible(`${label} function changed`);
  return fn;
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === "object" && typeof child.type === "string") walk(child, visit);
    }
  }
}

function inspect(runtime: string) {
  const login = namedFunction(runtime, "loginBigmodelCodingPlan");
  const param = login.params[0];
  if (param?.type !== "AssignmentPattern" || param.left.type !== "Identifier") incompatible("login options changed");
  const input = param.left.name;
  const body = runtime.slice(login.body.start + 1, login.body.end - 1);
  const factory = symbol(runtime, "createBigmodelOAuthClient");
  const [, client, http] = unique([...body.matchAll(new RegExp(
    `(${identifier})=${escape(factory)}\\(\\{httpClient:(${identifier})\\}\\)`, "gu"
  ))], "OAuth client call");
  const [, callback, state] = unique([...body.matchAll(new RegExp(
    `${escape(client!)}\\.buildAuthorizeUrl\\(\\{redirectUri:(${identifier})\\.callbackUrl,state:(${identifier})\\}\\)`, "gu"
  ))], "authorization callback");
  const persistence = unique([...body.matchAll(new RegExp(
    `\\[(${identifier})\\.bigmodelAccessToken\\]:(${identifier})\\.accessToken,`, "gu"
  ))], "credential persistence");
  const [, keys, tokens] = persistence;
  const bindings: VariableDeclarator[] = [];
  walk(login.body, node => {
    if (node.type === "VariableDeclarator") {
      const binding = node as VariableDeclarator;
      if (binding.id.type === "Identifier" && binding.id.name === tokens) bindings.push(binding);
    }
  });
  const binding = unique(bindings, "token binding");
  if (binding.init?.type !== "AwaitExpression" || binding.init.argument.type !== "CallExpression") incompatible("token exchange changed");
  const call = binding.init.argument;
  const args = call.arguments;
  if (args.length !== 1 || args[0]?.type !== "ObjectExpression") incompatible("token exchange options changed");
  const code = unique(args[0].properties.filter(node => node.type === "Property"
    && node.key.type === "Identifier" && node.key.name === "code"), "authorization code");
  if (code.type !== "Property") incompatible("authorization code changed");
  const codeSource = runtime.slice(code.value.start, code.value.end);
  const original = `${client}.exchangeCode({code:${codeSource}})`;
  const exchange = `${helper}.exchangeBigmodelOAuthCode({code:${codeSource},redirectUri:${callback}.callbackUrl,state:${state},httpClient:${http},abortSignal:${input}.abortSignal,trace:${input}.trace})`;
  const actual = runtime.slice(call.start, call.end);
  if (actual !== original && actual !== exchange) incompatible("token exchange call changed");
  const jwt = `[${keys}.zcodeJwtToken]:${tokens}.zcodeJwtToken,`;
  const persistenceEnd = login.body.start + 1 + persistence.index! + persistence[0].length;
  const stored = runtime.slice(persistenceEnd, persistenceEnd + jwt.length) === jwt;
  if ((actual === exchange) !== stored) incompatible("partial OAuth patch");
  return { call, exchange, persistenceEnd, jwt, patched: stored };
}

export function hasRuntimeBigmodelOAuth(runtime: string): boolean {
  try { return inspect(runtime).patched; } catch { return false; }
}

/** Exchange through the official Desktop broker and persist both provider and ZCode tokens. */
export function patchRuntimeBigmodelOAuth(runtime: string): string {
  const { call, exchange, persistenceEnd, jwt, patched } = inspect(runtime);
  if (patched) return runtime;
  const edits = [
    { start: call.start, end: call.end, value: exchange },
    { start: persistenceEnd, end: persistenceEnd, value: jwt }
  ];
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    runtime = runtime.slice(0, edit.start) + edit.value + runtime.slice(edit.end);
  }
  return runtime;
}
