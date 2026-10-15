import { parseExpressionAt, type FunctionExpression } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";
const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';
const marker = "zaiTokenKind";

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with shared OAuth (${detail}).`);
}

function unique<T>(values: T[], name: string): T {
  if (values.length !== 1) incompatible(`${name} missing or ambiguous`);
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
  const start = unique([...runtime.matchAll(new RegExp(`(?:async )?function ${escape(name)}\\(`, "gu"))], label).index!;
  const fn = parseExpressionAt(runtime, start, { ecmaVersion: "latest" });
  if (fn.type !== "FunctionExpression") incompatible(`${label} declaration changed`);
  return fn;
}

export function hasRuntimeSharedOAuth(runtime: string): boolean {
  if (!runtime.includes(marker)) return false;
  try {
    const body = (name: string) => { const fn = namedFunction(runtime, name); return runtime.slice(fn.start, fn.end); };
    const login = body("loginZCodeCli"), resolver = body("createCodingPlanApiKeyResolver");
    const headers = body("createStandaloneProviderRuntimeHeadersPort");
    return headers.includes(`${marker}:"business"`) && headers.includes(".saveIfValue(")
      && headers.includes(".sharedOAuthCredentialReader(")
      && body("readStandaloneAccountProviderConfigSnapshot").includes(".sharedOAuthCredentialReader(")
      && body("createSharedZCodeCredentialStore").includes("async saveIfValue(")
      && resolver.includes(`${marker}==="business"`) && resolver.includes("zaiBusinessToken:")
      && /\.business\.token\|\|new Headers\(/u.test(resolver)
      && [...login.matchAll(/\.saveZaiLoginCredentials\(\{accessToken:require\(require\("node:path"\)\.join\(__dirname,"cli-config.cjs"\)\)\.zaiBusinessAccessToken\(/gu)].length === 2
      && login.includes(".zaiBusinessAccessToken($zApiKey)")
      && login.indexOf("let $zApiKey=") < login.indexOf("$zStore.saveZaiLoginCredentials(");
  } catch { return false; }
}

/** Keep the Desktop credential contract across both login transports and standalone requests. */
export function patchRuntimeSharedOAuth(runtime: string): string {
  if (hasRuntimeSharedOAuth(runtime)) return runtime;
  if (runtime.includes(marker)) incompatible("partial patch");
  const edits: { start: number; end: number; value: string }[] = [];
  const replace = (fn: FunctionExpression, pattern: RegExp, change: (match: RegExpMatchArray) => string, name: string) => {
    const source = runtime.slice(fn.start, fn.end);
    const match = unique([...source.matchAll(pattern)], name);
    edits.push({ start: fn.start + match.index!, end: fn.start + match.index! + match[0].length, value: change(match) });
  };

  const resolver = namedFunction(runtime, "createCodingPlanApiKeyResolver");
  const resolverSource = runtime.slice(resolver.start, resolver.end);
  // 3.15.3 sends bare business tokens to metadata endpoints and Bearer tokens
  // to project issuance. Both forms must participate in native 401 recovery.
  replace(resolver, /new Headers\(([A-Za-z_$][\w$]*)\.headers\)\.get\("Authorization"\)===`Bearer \$\{([A-Za-z_$][\w$]*)\.business\.token\}`/gu,
    match => `(new Headers(${match[1]}.headers).get("Authorization")===${match[2]}.business.token||${match[0]})`, "business credential rejection");
  const business = unique([...resolverSource.matchAll(new RegExp(`(${identifier})=(${identifier})\\.family==="zai"\\?await (${identifier})\\.resolve\\(`, "gu"))], "business exchange");
  const attempt = unique([...resolverSource.matchAll(new RegExp(`for\\(let (${identifier})=0;`, "gu"))], "business retry")[1]!;
  // Shared credentials are business tokens. A definitive business HTTP 401 can
  // also mean a pre-fix CLI OAuth token; the native bounded retry exchanges it.
  replace(resolver, new RegExp(escape(business[0]), "gu"), match => match[0].replace('==="zai"?',
    `==="zai"?${business[2]}.${marker}==="business"&&${attempt}===0?{token:${business[2]}.accessToken.trim()}:`), "business exchange");
  const project = unique([...resolverSource.matchAll(new RegExp(`let (${identifier})=await ${identifier}\\.resolve\\(\\{origin:`, "gu"))], "project material")[1]!;
  replace(resolver, new RegExp(`return ${escape(project)}(?=\\})`, "gu"), () => `return ${business[1]}?{...${project},zaiBusinessToken:${business[1]}.token}:${project}`, "resolved business token");

  const snapshot = namedFunction(runtime, "readStandaloneAccountProviderConfigSnapshot");
  const snapshotSource = runtime.slice(snapshot.start, snapshot.end);
  const providers = unique([...snapshotSource.matchAll(new RegExp(`(${identifier})=${identifier}\\.providers,(${identifier})=\\1\\.map\\(`, "gu"))], "captured provider catalog");
  replace(snapshot, new RegExp(`await (${identifier})\\.loadMany\\(${escape(providers[2]!)}\\)`, "gu"),
    match => `await ${helper}.sharedOAuthCredentialReader(${match[1]},async()=>${providers[1]}).loadMany(${providers[2]})`, "shared account identities");
  const headers = namedFunction(runtime, "createStandaloneProviderRuntimeHeadersPort");
  const [headerStore, headerEnv] = headers.params;
  if (headerStore?.type !== "Identifier" || headerEnv?.type !== "Identifier") incompatible("request auth parameters changed");
  // Request auth already carries the registry's captured provider/family pair.
  // Reopening the configured catalog here would bypass native fallback recovery.
  edits.push({ start: headers.body.start + 1, end: headers.body.start + 1,
    value: `let $zSharedProviders=new Map;${headerStore.name}=${helper}.sharedOAuthCredentialReader(${headerStore.name},async()=>[...$zSharedProviders.values()]);` });
  replace(headers, /async refreshBeforeModelRequest\(([A-Za-z_$][\w$]*)\)\{/gu,
    match => `${match[0]}$zSharedProviders.set(${match[1]}.providerId.trim(),{providerId:${match[1]}.providerId.trim(),family:${match[1]}.accountAccess?.accountType});`, "request provider identity");
  replace(headers, /\.resolveMaterial\(\{family:([A-Za-z_$][\w$]*),accessToken:([A-Za-z_$][\w$]*),/gu,
    match => `${match[0]}${marker}:"business",`, "shared token request");

  const credentials = namedFunction(runtime, "createSharedZCodeCredentialStore");
  const returned = credentials.body.body.find(node => node.type === "ReturnStatement");
  if (returned?.type !== "ReturnStatement" || returned.argument?.type !== "ObjectExpression") incompatible("credential store changed");
  if (returned.argument.properties.some(node => node.type === "Property" && node.key.type === "Identifier" && node.key.name === "saveIfValue")) incompatible("credential comparison already exists");
  const compare = unique(returned.argument.properties.filter(node => node.type === "Property"
    && node.key.type === "Identifier" && node.key.name === "deleteIfValue"), "credential comparison");
  if (compare.type !== "Property" || compare.value.type !== "FunctionExpression") incompatible("credential comparison changed");
  const [key, expected] = compare.value.params;
  const validation = compare.value.body.body[0];
  if (key?.type !== "Identifier" || expected?.type !== "Identifier" || validation?.type !== "VariableDeclaration") incompatible("credential validation changed");
  const validator = validation.declarations[1]?.init;
  if (validator?.type !== "CallExpression" || validator.callee.type !== "Identifier") incompatible("credential value validation changed");
  const compareSource = runtime.slice(compare.start, compare.end);
  const cipher = unique([...compareSource.matchAll(new RegExp(`(${identifier})\\.decrypt\\(`, "gu"))], "credential cipher")[1]!;
  const deletion = unique([...compareSource.matchAll(new RegExp(`delete (${identifier})\\[(${identifier})\\]`, "gu"))], "conditional credential mutation");
  const conditionalSave = compareSource.replace(`deleteIfValue(${key.name},${expected.name})`, `saveIfValue(${key.name},${expected.name},$zValue)`)
    .replace(deletion[0], `${deletion[1]}[${deletion[2]}]=${cipher}.encrypt(${validator.callee.name}($zValue))`);
  edits.push({ start: compare.end, end: compare.end, value: `,${conditionalSave}` });

  const headerSource = runtime.slice(headers.start, headers.end);
  const request = unique([...headerSource.matchAll(new RegExp(`let (${identifier})=await (${identifier})\\.resolveMaterial\\(\\{family:(${identifier}),accessToken:(${identifier}),accountIdentity:(${identifier}),[^{}]+\\},\\{signal:(${identifier})\\.abortSignal\\}\\);`, "gu"))], "shared request material");
  const scope = unique([...headerSource.matchAll(new RegExp(`(${identifier})=\\(0,${identifier}\\.createHash\\)\\("sha256"\\)\\.update\\(JSON\\.stringify\\(\\[${identifier},${identifier},${identifier},${escape(request[4]!)}\\]\\)\\)\\.digest\\("hex"\\)`, "gu"))], "request account scope");
  const snapshotEntry = unique([...headerSource.matchAll(new RegExp(`(${identifier})\\.set\\((${identifier}),${escape(request[4]!)}\\)`, "gu"))], "credential snapshot");
  const store = headers.params[0];
  if (store?.type !== "Identifier") incompatible("request credential store changed");
  const [materialName, resolverName, familyName, tokenName, , inputName] = request.slice(1);
  const businessToken = `${materialName}.zaiBusinessToken`, oauthKey = snapshotEntry[2];
  const migration = `if(${familyName}==="zai"&&${businessToken}&&${businessToken}!==${tokenName}){${inputName}.abortSignal?.throwIfAborted();`
    + `if(!await ${store.name}.saveIfValue(${oauthKey},${tokenName},${businessToken})&&await ${store.name}.load(${oauthKey})!==${businessToken})throw ${resolverName}.clear(),new Error("project_token_scope_invalidated");`
    + `${tokenName}=${businessToken};${scope[0]};${snapshotEntry[1]}.set(${oauthKey},${tokenName});}`;
  const migrationStart = headers.start + request.index! + request[0].length;
  edits.push({ start: migrationStart, end: migrationStart, value: migration });

  const login = namedFunction(runtime, "loginZCodeCli");
  const materialResolver = symbol(runtime, "resolveCodingPlanMaterial");
  const source = runtime.slice(login.start, login.end);
  const material = unique([...source.matchAll(new RegExp(`(${identifier})=await ${identifier}\\(${escape(materialResolver)}\\(\\{accessToken:(${identifier})\\.accessToken,`, "gu"))], "polling login material");
  replace(login, new RegExp(`\\.saveZaiLoginCredentials\\(\\{accessToken:${escape(material[2]!)}\\.accessToken,`, "gu"),
    () => `.saveZaiLoginCredentials({accessToken:${helper}.zaiBusinessAccessToken(${material[1]}),`, "polling credential publication");

  // The macOS bridge originally published the raw token before resolving model access.
  // Move resolution ahead of publication so a failed exchange leaves the shared login intact.
  const bridge = login.body.body.find(node => node.type === "IfStatement"
    && runtime.slice(node.test.start, node.test.end).includes("ZCODE_CLI_OAUTH_CALLBACK_STDIN"));
  if (bridge?.type !== "IfStatement" || bridge.consequent.type !== "BlockStatement") incompatible("macOS login bridge missing");
  const statements = bridge.consequent.body;
  const publication = unique(statements.filter(node => node.type === "TryStatement"
    && runtime.slice(node.block.start, node.block.end).includes("$zStore.saveZaiLoginCredentials")), "macOS credential publication");
  const resolution = unique(statements.filter(node => node.type === "VariableDeclaration"
    && node.declarations.some(declaration => declaration.id.type === "Identifier" && declaration.id.name === "$zApiKey")), "macOS login material");
  const resolutionSource = runtime.slice(resolution.start, resolution.end);
  if (!resolutionSource.includes(`await ${materialResolver}(`) || publication.end > resolution.start) incompatible("macOS publication order changed");
  const loginOptions = login.params[0];
  if (loginOptions?.type !== "AssignmentPattern" || loginOptions.left.type !== "Identifier") incompatible("login options changed");
  edits.push({ start: publication.start, end: publication.start,
    value: `${resolutionSource}${loginOptions.left.name}.abortSignal?.throwIfAborted();` });
  edits.push({ start: resolution.start, end: resolution.end, value: "" });
  const accessToken = unique([...runtime.slice(publication.start, publication.end).matchAll(/accessToken:\$zAccessToken,/gu)], "macOS shared token");
  edits.push({ start: publication.start + accessToken.index!, end: publication.start + accessToken.index! + accessToken[0].length,
    value: `accessToken:${helper}.zaiBusinessAccessToken($zApiKey),` });

  // Reject unexpected overlaps before touching the bundle.
  const sorted = edits.sort((a, b) => b.start - a.start);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.end > sorted[i - 1]!.start) incompatible("overlapping edits");
  for (const edit of sorted) runtime = runtime.slice(0, edit.start) + edit.value + runtime.slice(edit.end);
  if (!hasRuntimeSharedOAuth(runtime)) incompatible("postcondition failed");
  return runtime;
}
