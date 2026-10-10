const identifier = "[A-Za-z_$][\\w$]*";
const marker = "ZCODE_CLI_START_PLAN";

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with standalone Start Plan (${detail}).`);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function hasRuntimeStandaloneStartPlan(runtime: string): boolean {
  return runtime.includes(marker);
}

/**
 * Standalone runtimes only entitle Individual Coding Plan accounts, so the
 * ZCode Start Plan stays hidden outside Desktop. Desktop entitles it for the
 * active OAuth family and authenticates requests with the ZCode JWT from the
 * shared credential file plus the ZCode source headers (including the shared
 * device ID). Do the same; the ZCode server still decides whether a plan is
 * active. ZCODE_CLI_START_PLAN=0 hides it.
 */
export function patchRuntimeStandaloneStartPlan(runtime: string): string {
  if (hasRuntimeStandaloneStartPlan(runtime)) return runtime;
  const labelled = (label: string): { name: string; start: number; end: number } => {
    const symbol = new RegExp(`${identifier}\\((${identifier}),"${label}"\\)`, "u").exec(runtime)?.[1];
    const start = symbol ? runtime.search(new RegExp(`(?:async )?function ${escape(symbol)}\\(`, "u")) : -1;
    const bodyStart = start < 0 ? -1 : runtime.indexOf("{", start);
    const end = bodyStart < 0 ? -1 : runtime.slice(bodyStart).search(/(?:async )?function [A-Za-z_$]/u) + bodyStart;
    if (!symbol || start < 0 || end <= start) incompatible(`${label} missing`);
    return { name: symbol!, start, end };
  };

  const catalog = labelled("readStandaloneCodingPlanCatalog");
  const snapshot = labelled("readStandaloneAccountProviderConfigSnapshot");
  const headersPort = labelled("createStandaloneProviderRuntimeHeadersPort");
  const sourceHeaders = labelled("createProviderEndpointRoutingSourceHeaders");
  // esbuild registers a module's names inside its lazy initializer; call it before use.
  const sourceHeadersLabel = runtime.indexOf(`(${sourceHeaders.name},"createProviderEndpointRoutingSourceHeaders")`);
  const sourceHeadersInit = [...runtime.slice(0, sourceHeadersLabel).matchAll(new RegExp(`(${identifier})=${identifier}\\(\\(\\)=>\\{"use strict";`, "gu"))].at(-1)?.[1]
    ?? incompatible("source header module missing");

  const catalogBody = runtime.slice(catalog.start, catalog.end);
  const catalogReturn = new RegExp(`if\\((${identifier})\\)return\\{zcodeBuiltinRevision:(${identifier})\\.revision,providers:(${identifier})\\.providers\\.entries\\(\\)\\.flatMap\\(`, "u").exec(catalogBody);
  if (!catalogReturn || catalogReturn[1] !== catalogReturn[2] || catalogReturn[1] !== catalogReturn[3]) incompatible("catalog return changed");
  const catalogInput = catalogReturn![1];
  const catalogInsert = catalog.start + catalogReturn!.index + catalogReturn![0].indexOf("providers:");
  const startPlanProviders = `$startPlanProviders:[...${catalogInput}.providers.entries()].flatMap(([$spId,$spConfig])=>$spConfig.access?.type==="zhipu-account"&&$spConfig.access.mode==="start-plan"&&$spConfig.access.accountType?[{family:$spConfig.access.accountType,providerId:$spId}]:[]),`;

  const snapshotBody = runtime.slice(snapshot.start, snapshot.end);
  const snapshotParams = new RegExp(`^async function ${escape(snapshot.name)}\\((${identifier}),(${identifier}),(${identifier})\\)\\{let (${identifier})=await ${escape(catalog.name)}\\((${identifier}),(${identifier})\\)`, "u").exec(snapshotBody);
  if (!snapshotParams || snapshotParams[5] !== snapshotParams[2] || snapshotParams[6] !== snapshotParams[3]) incompatible("snapshot parameters changed");
  const [, store, env, , result] = snapshotParams!;
  const accountConfig = new RegExp(`new (${identifier})\\(\\{access:new (${identifier})\\(\\{entitled:!0\\}\\)\\}\\)`, "u").exec(snapshotBody);
  const configMap = new RegExp(`=new (${identifier})\\(${identifier}\\.map\\(\\(\\{family:`, "u").exec(snapshotBody)?.[1];
  const snapshotReturn = new RegExp(`return (${identifier})\\((${identifier})\\.zcodeBuiltinRevision,(${identifier})\\)\\}$`, "u").exec(snapshotBody);
  if (!accountConfig || !configMap || !snapshotReturn || snapshotReturn[2] !== result) incompatible("snapshot entitlement changed");
  const [, createSnapshot, , providers] = snapshotReturn!;
  const entitled = [
    `let $spProviders=${result}.$startPlanProviders??[],$spCredentials=$spProviders.length&&${env}.${marker}!=="0"?await ${store}.loadMany(["zcodejwttoken","oauth:active_provider"]):{},`,
    `$spJwt=$spCredentials.zcodejwttoken?.trim(),$spActive=$spCredentials["oauth:active_provider"]?.trim();`,
    `return ${createSnapshot}(${result}.zcodeBuiltinRevision,$spProviders.length?${providers}.overlay(new ${configMap}($spProviders.map(({family:$spFamily,providerId:$spId})=>[$spId,new ${accountConfig![1]}({access:new ${accountConfig![2]}({entitled:!!$spJwt&&$spActive===$spFamily})})]))):${providers})}`
  ].join("");
  const snapshotReturnStart = snapshot.start + snapshotReturn!.index;

  const portBody = runtime.slice(headersPort.start, headersPort.end);
  const portParams = new RegExp(`^function ${escape(headersPort.name)}\\((${identifier}),(${identifier})\\)\\{return\\{`, "u").exec(portBody);
  const guard = new RegExp(`let ${identifier}=(${identifier})\\.providerId\\.trim\\(\\),(${identifier})=(${identifier})\\.accountAccess;if\\(!(${identifier})\\|\\|(${identifier})\\.mode!=="individual-coding-plan"\\)throw`, "u").exec(portBody);
  if (!portParams || !guard || guard[1] !== guard[3] || guard[2] !== guard[4] || guard[2] !== guard[5]) incompatible("request auth guard changed");
  const [, portStore, portEnv] = portParams!;
  const access = guard![2];
  const guardInsert = headersPort.start + guard!.index + guard![0].indexOf("if(!");
  const startPlanAuth = [
    `if(${access}?.mode==="start-plan"){`,
    `let $spJwt=(await ${portStore}.load("zcodejwttoken"))?.trim();`,
    `if(!$spJwt)throw new Error("Start Plan needs a ZCode sign-in: sign in with ZCode Desktop or /login, then retry.");`,
    `${sourceHeadersInit}();`,
    `return{headersApplied:!0,requestAuth:{apiKey:$spJwt,headers:await ${sourceHeaders.name}({env:${portEnv}})}}}`
  ].join("");

  const edits = [
    { at: catalogInsert, remove: 0, value: startPlanProviders },
    { at: snapshotReturnStart, remove: snapshotReturn![0].length, value: entitled },
    { at: guardInsert, remove: 0, value: startPlanAuth }
  ].sort((left, right) => right.at - left.at);
  for (const edit of edits) {
    runtime = runtime.slice(0, edit.at) + edit.value + runtime.slice(edit.at + edit.remove);
  }
  return runtime;
}
