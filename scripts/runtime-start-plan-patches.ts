import { parseExpressionAt, type FunctionExpression } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";

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

/**
 * Admit z.ai/bigmodel Start Plan providers (for example the ZCODE WEEKEND BUILD
 * token promos) in standalone mode. The bundled provider catalog already ships
 * `account:zai-start-plan` / `account:bigmodel-start-plan`, and Desktop's host
 * registers them whenever the account is entitled, but the standalone account
 * paths only enumerate Individual Coding Plan providers. Five minimal edits:
 *
 * 1. the standalone catalog reader enumerates Start Plan providers as well, so
 *    they reach the provider registry and get an entitlement computed;
 * 2. the login provider resolution keeps its "exactly one per family" contract
 *    by excluding Start Plan providers (login must keep targeting the Coding
 *    Plan api-key flow);
 * 3. the standalone identity credential key maps Start Plan providers to the
 *    family's Coding Plan identity — the identity is account-scoped, and the
 *    server reports Start Plan grants for the same account;
 * 4. the request credential refresher accepts the Start Plan access mode;
 * 5. Start Plan requests authenticate with the zcode-scoped JWT credential
 *    (`zcodejwttoken`): Start Plan traffic is served from
 *    `zcode.z.ai/api/v1/zcode-plan/...`, which rejects the Coding Plan api-key
 *    and the exchanged api.z.ai project JWT with 401.
 *
 * No protocol changes: requests are still built and signed by the genuine
 * runtime; only provider enumeration and credential selection are widened to
 * cover an entitlement the account already has.
 */

/** True when the runtime already admits Start Plan providers standalone (native or patched). */
export function hasRuntimeStartPlan(runtime: string): boolean {
  try {
    const catalog = namedFunction(runtime, "readStandaloneCodingPlanCatalog");
    const headers = namedFunction(runtime, "createStandaloneProviderRuntimeHeadersPort");
    return runtime.slice(catalog.start, catalog.end).includes('"start-plan"')
      && runtime.slice(headers.start, headers.end).includes('mode==="start-plan"');
  } catch {
    return false;
  }
}

export function patchRuntimeStartPlan(runtime: string): string {
  if (hasRuntimeStartPlan(runtime)) return runtime;
  const edits: { start: number; end: number; value: string }[] = [];
  const plan = (label: string, pattern: RegExp, value: string, name: string) => {
    const fn = namedFunction(runtime, label);
    const source = runtime.slice(fn.start, fn.end);
    const match = unique([...source.matchAll(pattern)], name);
    edits.push({ start: fn.start + match.index!, end: fn.start + match.index! + match[0].length, value });
  };

  // 1) standalone catalog: enumerate Start Plan providers beside Coding Plan providers
  plan("readStandaloneCodingPlanCatalog",
    new RegExp('c\\?\\.type==="zhipu-account"&&c\\.mode==="individual-coding-plan"&&c\\.accountType&&u', "gu"),
    'c?.type==="zhipu-account"&&(c.mode==="individual-coding-plan"||c.mode==="start-plan")&&c.accountType&&u',
    "catalog provider predicate");

  // 2) login: keep resolving the Coding Plan provider uniquely (Start Plan must not break it)
  plan("resolveStandaloneCodingPlanProvider",
    new RegExp('\\.filter\\(o=>o\\.family===e\\);if\\(n\\.length!==1\\)', "gu"),
    '.filter(o=>o.family===e&&!/-start-plan$/.test(o.providerId));if(n.length!==1)',
    "login provider uniqueness filter");

  // 3) identity: Start Plan providers share the family's account-scoped identity credential
  plan("standaloneAccountIdentityCredentialKey",
    new RegExp('return`account-provider:\\$\\{t\\}:identity`', "gu"),
    'return`account-provider:${/-start-plan$/.test(t)?t.replace(/-start-plan$/u,"-individual-coding-plan"):t}:identity`',
    "identity credential key mapping");

  // 4) request refresher: accept the Start Plan access mode
  plan("createStandaloneProviderRuntimeHeadersPort",
    new RegExp('if\\(!f\\|\\|f\\.mode!=="individual-coding-plan"\\)throw', "gu"),
    'if(!f||f.mode!=="individual-coding-plan"&&f.mode!=="start-plan")throw',
    "request access mode check");

  // 5) request auth: Start Plan requests use the zcode-scoped JWT credential
  const credentialCheck = 'if(c.abortSignal?.throwIfAborted(),!R)throw new Error(`Standalone Account Provider \\u7F3A\\u5C11\\u8BF7\\u6C42\\u51ED\\u636E: ${u}`)';
  plan("createStandaloneProviderRuntimeHeadersPort",
    new RegExp(escapePattern(credentialCheck), "gu"),
    `if(f?.mode==="start-plan"){let $zSpToken=(await e.load("zcodejwttoken"))?.trim();if($zSpToken)R=$zSpToken}${credentialCheck}`,
    "Start Plan request auth override");

  edits.sort((first, second) => second.start - first.start);
  let output = runtime;
  for (const edit of edits) output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  return output;
}
