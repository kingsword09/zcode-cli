import { parseExpressionAt, type FunctionExpression } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";
const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with standalone Start Plan support (${detail}).`);
}

function unique<Item>(items: Item[], name: string): Item {
  if (items.length !== 1) incompatible(`${name} missing or ambiguous`);
  return items[0]!;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function namedFunction(runtime: string, label: string): FunctionExpression {
  const name = unique([...runtime.matchAll(new RegExp(`${identifier}\\((${identifier}),"${label}"\\)`, "gu"))], label)[1]!;
  const start = unique([...runtime.matchAll(new RegExp(`(?:async )?function ${escapePattern(name)}\\(`, "gu"))], label).index!;
  const fn = parseExpressionAt(runtime, start, { ecmaVersion: "latest" });
  if (fn.type !== "FunctionExpression") incompatible(`${label} declaration changed`);
  return fn;
}

export function hasRuntimeStartPlan(runtime: string): boolean {
  try {
    const body = (label: string) => { const fn = namedFunction(runtime, label); return runtime.slice(fn.start, fn.end); };
    return body("readStandaloneCodingPlanCatalog").includes('mode:c.mode')
      && body("readStandaloneCodingPlanCatalog").includes('c.mode==="start-plan"')
      && body("resolveStandaloneCodingPlanProvider").includes('o.mode==="individual-coding-plan"')
      && body("readStandaloneAccountProviderConfigSnapshot").includes(`${helper}.readStartPlanSession(`)
      && body("readStandaloneAccountProviderConfigSnapshot").includes('$zStartSession?.family===')
      && body("createStandaloneProviderRuntimeHeadersPort").includes(`${helper}.refreshStandaloneStartPlanRequest(`);
  } catch {
    return false;
  }
}

export function patchRuntimeStartPlan(runtime: string): string {
  if (hasRuntimeStartPlan(runtime)) return runtime;
  const edits: { start: number; end: number; value: string }[] = [];
  const replace = (fn: FunctionExpression, pattern: RegExp, change: (match: RegExpMatchArray) => string, name: string) => {
    const match = unique([...runtime.slice(fn.start, fn.end).matchAll(pattern)], name);
    edits.push({ start: fn.start + match.index!, end: fn.start + match.index! + match[0].length, value: change(match) });
  };

  const catalog = namedFunction(runtime, "readStandaloneCodingPlanCatalog");
  replace(catalog, /c\?\.type==="zhipu-account"&&c\.mode==="individual-coding-plan"&&c\.accountType&&u/gu,
    () => 'c?.type==="zhipu-account"&&(c.mode==="individual-coding-plan"||c.mode==="start-plan")&&c.accountType&&u', "catalog predicate");
  replace(catalog, /\{family:c\.accountType,modelId:u,providerId:i\}/gu,
    () => '{family:c.accountType,modelId:u,providerId:i,mode:c.mode}', "catalog access mode");

  replace(namedFunction(runtime, "resolveStandaloneCodingPlanProvider"), /\.filter\(o=>o\.family===e\)/gu,
    () => '.filter(o=>o.family===e&&o.mode==="individual-coding-plan")', "login provider selection");

  const snapshot = namedFunction(runtime, "readStandaloneAccountProviderConfigSnapshot");
  const [store] = snapshot.params;
  if (store?.type !== "Identifier") incompatible("snapshot credential store changed");
  const source = runtime.slice(snapshot.start, snapshot.end);
  const providers = unique([...source.matchAll(new RegExp(`(${identifier})=(${identifier})\\.providers,`, "gu"))], "snapshot providers");
  const providerMap = unique([...source.matchAll(new RegExp(`(${identifier})=new (${identifier})\\(${escapePattern(providers[1]!)}\\.map\\(`, "gu"))], "provider map");
  const config = unique([...source.matchAll(new RegExp(`new (${identifier})\\(\\{access:new (${identifier})\\(\\{entitled:!0\\}\\)\\}\\)`, "gu"))], "entitlement config");
  replace(snapshot, new RegExp(escapePattern(providers[0]), "gu"), () =>
    `$zStartSession=${providers[2]}.providers.some($zProvider=>$zProvider.mode==="start-plan")?await ${helper}.readStartPlanSession(${store.name}):void 0,`
    + `${providers[1]}=${providers[2]}.providers.filter($zProvider=>$zProvider.mode!=="start-plan"),`, "independent Start Plan snapshot");
  replace(snapshot, new RegExp(`return (${identifier})\\(${escapePattern(providers[2]!)}\\.zcodeBuiltinRevision,${escapePattern(providerMap[1]!)}\\)`, "gu"), match =>
    `return ${match[1]}(${providers[2]}.zcodeBuiltinRevision,new ${providerMap[2]}([...${providerMap[1]}.entries(),`
    + `...${providers[2]}.providers.filter($zProvider=>$zProvider.mode==="start-plan").map(({family:$zFamily,providerId:$zProviderId})=>`
    + `[$zProviderId,new ${config[1]}({access:new ${config[2]}({entitled:$zStartSession?.family===$zFamily})})])]))`, "Start Plan entitlements");

  const headers = namedFunction(runtime, "createStandaloneProviderRuntimeHeadersPort");
  const [headerStore] = headers.params;
  if (headerStore?.type !== "Identifier") incompatible("request credential store changed");
  replace(headers, new RegExp(`let (${identifier})=(${identifier})\\.providerId\\.trim\\(\\),(${identifier})=\\2\\.accountAccess;`, "gu"), match =>
    `${match[0]}if(${match[3]}?.mode==="start-plan")return ${helper}.refreshStandaloneStartPlanRequest(${headerStore.name},${match[2]});`, "Start Plan request branch");

  let output = runtime;
  for (const edit of edits.sort((first, second) => second.start - first.start)) {
    output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  }
  if (!hasRuntimeStartPlan(output)) incompatible("postcondition verification failed");
  return output;
}
