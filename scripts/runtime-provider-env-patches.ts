import { parseExpressionAt, type FunctionExpression } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";
const fallbackName = "$zBuiltinEnvFallback";

function incompatible(): never {
  throw new Error("ZCode runtime is incompatible with built-in provider environment recovery (missing, ambiguous or changed bootstrap anchors).");
}

function unique<Item>(items: Item[]): Item {
  if (items.length !== 1) incompatible();
  return items[0]!;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function namedFunction(runtime: string, label: string): FunctionExpression {
  const name = unique([...runtime.matchAll(new RegExp(`${identifier}\\((${identifier}),"${label}"\\)`, "gu"))])[1]!;
  const start = unique([...runtime.matchAll(new RegExp(`(?:async )?function ${escapePattern(name)}\\(`, "gu"))]).index!;
  const fn = parseExpressionAt(runtime, start, { ecmaVersion: "latest" });
  if (fn.type !== "FunctionExpression" || !fn.id) incompatible();
  return fn;
}

function inspect(runtime: string) {
  const prepare = namedFunction(runtime, "prepareCliProviderRuntimeEnv");
  const reader = namedFunction(runtime, "readReleaseCandidate").id!.name;
  const resolver = namedFunction(runtime, "resolveBundledZCodeBuiltinProviderConfig").id!.name;
  const bundledKey = unique([...runtime.matchAll(new RegExp(`(${identifier})="ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE"`, "gu"))])[1]!;
  if (prepare.params.length !== 1 || prepare.params[0]?.type !== "Identifier") incompatible();
  const options = prepare.params[0].name;
  const initial = prepare.body.body[1];
  if (prepare.body.body[0]?.type !== "IfStatement" || initial?.type !== "VariableDeclaration"
    || initial.declarations.length !== 3) incompatible();
  const bindings = initial.declarations.slice(0, 2).map(binding => {
    if (binding.id.type !== "Identifier" || !binding.init) incompatible();
    const source = runtime.slice(binding.init.start, binding.init.end);
    const match = new RegExp(`^${escapePattern(options)}\\.env\\[(${identifier})\\]\\?\\.trim\\(\\)(\\|\\|void 0)?$`, "u").exec(source);
    if (!match) incompatible();
    return { name: binding.id.name, key: match[1]!, init: binding.init, source,
      replacement: `${options}.env[${match[1]}]?.trim()||void 0` };
  });
  const builtin = bindings[0]!;
  const personal = bindings[1]!;
  for (const [binding, key] of [[builtin, "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"], [personal, "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]] as const) {
    unique([...runtime.matchAll(new RegExp(`${escapePattern(binding.key)}="${key}"`, "gu"))]);
  }
  const bundled = unique(prepare.body.body.flatMap(statement => statement.type === "VariableDeclaration"
    ? statement.declarations.filter(binding => binding.init?.type === "LogicalExpression" && binding.init.operator === "??"
      && binding.init.right.type === "AwaitExpression" && binding.init.right.argument.type === "CallExpression"
      && binding.init.right.argument.callee.type === "Identifier" && binding.init.right.argument.callee.name === resolver) : []));
  if (bundled.init?.type !== "LogicalExpression" || bundled.init.right.type !== "AwaitExpression") incompatible();
  const discovery = runtime.slice(bundled.init.right.start, bundled.init.right.end);
  const original = `${builtin.name}??${discovery}`;
  const replacement = `${fallbackName}??${original}`;
  const bundledSource = runtime.slice(bundled.init.start, bundled.init.end);
  if (bundledSource !== original && bundledSource !== replacement) incompatible();
  const recovery = [
    `let ${fallbackName};`,
    `if(${builtin.name}){let $zBuiltinEnvCandidate=await ${reader}(${builtin.name});`,
    "if(!$zBuiltinEnvCandidate?.release){",
    `let $zBuiltinEnvResolved=${options}.env[${bundledKey}]?.trim();`,
    `if(!$zBuiltinEnvResolved||!(await ${reader}($zBuiltinEnvResolved))?.release){`,
    `$zBuiltinEnvResolved=void 0;try{$zBuiltinEnvResolved=${discovery}}catch{}}`,
    `if($zBuiltinEnvResolved&&(await ${reader}($zBuiltinEnvResolved))?.release)${fallbackName}=$zBuiltinEnvResolved;`,
    'let $zBuiltinEnvReason=$zBuiltinEnvCandidate?.error instanceof SyntaxError?"invalid JSON":',
    '$zBuiltinEnvCandidate?.error?.code??($zBuiltinEnvCandidate?.error?"invalid built-in release":"file not found");',
    `process.stderr.write("ZCode Built-in: ignoring unavailable ZCODE_BUILTIN_PROVIDER_CONFIG_FILE "+JSON.stringify(${builtin.name})+`,
    `" ("+$zBuiltinEnvReason+"); "+(${fallbackName}?"using bundled catalog "+JSON.stringify(${fallbackName}):"no valid bundled fallback")+".\\n");`,
    `if(${fallbackName})${builtin.name}=void 0;}}`
  ].join("");
  const inserted = runtime.slice(initial.end, initial.end + recovery.length) === recovery;
  const patched = inserted && bindings.every(binding => binding.source === binding.replacement) && bundledSource === replacement;
  if (runtime.slice(prepare.start, prepare.end).includes(fallbackName) && !patched) incompatible();
  return { patched, bindings, initial, bundled: bundled.init, replacement, recovery };
}

export function hasRuntimeBuiltinProviderEnvRecovery(runtime: string): boolean {
  try { return inspect(runtime).patched; } catch { return false; }
}

export function patchRuntimeBuiltinProviderEnvRecovery(runtime: string): string {
  const inspected = inspect(runtime);
  if (inspected.patched) return runtime;
  const edits = [
    ...inspected.bindings.map(binding => ({ start: binding.init.start, end: binding.init.end, text: binding.replacement })),
    { start: inspected.initial.end, end: inspected.initial.end, text: inspected.recovery },
    { start: inspected.bundled.start, end: inspected.bundled.end, text: inspected.replacement }
  ];
  for (const edit of edits.sort((first, second) => second.start - first.start)) {
    runtime = runtime.slice(0, edit.start) + edit.text + runtime.slice(edit.end);
  }
  return runtime;
}
