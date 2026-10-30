import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";
import { hasRuntimeSharedOAuth, patchRuntimeSharedOAuth } from "../../scripts/runtime-shared-oauth-patches.ts";

const root = join(import.meta.dir, "../..");

test("the shared OAuth patch is idempotent and rejects partially patched credentials", async () => {
  const source = await readFile(join(root, "vendor/zcode.cjs"), "utf8");
  expect(hasRuntimeSharedOAuth(source)).toBe(true);
  expect(patchRuntimeSharedOAuth(source)).toBe(source);
  for (const partial of [source.replace('zaiTokenKind:"business"', 'zaiTokenKind:"oauth"'),
    source.replace("async saveIfValue(", "async removedIfValue(")]) {
    expect(hasRuntimeSharedOAuth(partial)).toBe(false);
    expect(() => patchRuntimeSharedOAuth(partial)).toThrow("partial patch");
  }
}, 15_000);

/** Run native login, encryption, account projection and request signing; only HTTP is simulated. */
async function probe(body: string, options: { callback?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-shared-oauth-"));
  try {
    const file = join(root, "vendor/zcode.cjs");
    const source = await readFile(file, "utf8");
    const names = ["loginZCodeCli", "createSharedZCodeCredentialStore", "createCodingPlanApiKeyResolver",
      "readStandaloneAccountProviderConfigSnapshot", "createStandaloneProviderRuntimeHeadersPort"];
    const symbols = names.map(name => {
      const match = new RegExp(`[A-Za-z_$][\\w$]*\\(([A-Za-z_$][\\w$]*),"${name}"\\)`, "u").exec(source);
      if (!match) throw new Error(`Missing native function: ${name}`);
      const init = [...source.slice(0, match.index).matchAll(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\(\)=>\{/gu)].at(-1)?.[1];
      if (!init) throw new Error(`Missing native initializer: ${name}`);
      return { symbol: match[1], init };
    });
    const main = /async function [A-Za-z_$][\w$]*\(\)\{let [A-Za-z_$][\w$]*=process\.argv\.slice\(2\);/u.exec(source);
    if (!main) throw new Error("Missing native entry point");
    const injected = symbols.map(value => `${value.init}();`).join("")
      + `await(async(${names.join(",")})=>{${httpFixture}try{${body};console.log("SHARED_OAUTH_OK")}catch(error){console.error("Fixture requests:",JSON.stringify(calls));throw error}})(${symbols.map(value => value.symbol).join(",")}).catch(error=>{console.error(error.stack);process.exitCode=1});return;`;
    const script = `const fs=require("node:fs"),Module=require("node:module"),path=require("node:path");
      const file=${JSON.stringify(file)},runtime=new Module(file,module);
      runtime.filename=file;runtime.paths=Module._nodeModulePaths(path.dirname(file));
      runtime._compile(fs.readFileSync(file,"utf8").replace(${JSON.stringify(main[0])},${JSON.stringify(main[0] + injected)}),file);`;
    const child = Bun.spawn([Bun.which("node")!, "--eval", script], {
      cwd: directory,
      env: { ...runtimeTestEnv(directory), ZCODE_CREDENTIAL_SECRET: "shared-oauth-test-secret",
        ...options.callback ? { ZCODE_CLI_OAUTH_CALLBACK_STDIN: "1" } : {} },
      stdin: new Blob([JSON.stringify({ callbackUrl: "zcode://zai-auth/callback?code=fixture-code&state=fixture-state", state: "fixture-state" })]),
      stdout: "pipe", stderr: "pipe"
    });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr || stdout).toBe(0);
      expect(stdout).toContain("SHARED_OAUTH_OK");
    } finally { clearTimeout(timer); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const httpFixture = `
  const assert=require("node:assert/strict"),fs=require("node:fs/promises");
  const env={...process.env},providerId="account:zai-individual-coding-plan";
  const store=createSharedZCodeCredentialStore({env});
  const calls=[];
  let businessToken="fixture-business-token",projectToken="fixture-project-token",rejectExchange=false,rejectedStatus=401,beforeIssue;
  const response=(data,status=200)=>({status,body:new TextEncoder().encode(JSON.stringify({code:status===200?0:status,data}))});
  const httpClient={request:async(request)=>{try{
    const url=new URL(request.url);calls.push(url.pathname);
    if(url.pathname==="/api/v1/oauth/cli/init")return response({authorize_url:"https://example.test/login",flow_id:"flow",expires_at:Math.ceil(Date.now()/1000)+60,poll_interval_sec:1});
    if(url.pathname==="/api/v1/oauth/cli/poll/flow")return response({status:"ready",token:"fixture-zcode-jwt",user:{user_id:"fixture-user"},zai:{access_token:"fixture-oauth-token"}});
    if(url.pathname==="/api/v1/oauth/token")return response({token:"fixture-zcode-jwt",user:{user_id:"fixture-user"},zai:{access_token:"fixture-oauth-token"}});
    if(url.pathname==="/api/auth/z/login"){
      const input=JSON.parse(new TextDecoder().decode(request.body));
      if(rejectExchange||input.token!=="fixture-oauth-token")return response({},401);
      return response({access_token:businessToken});
    }
    const auth=new Headers(request.headers).get("authorization");
    if(auth!=="Bearer "+businessToken&&(auth!==businessToken||url.pathname.endsWith("/access_tokens")))return response({},rejectedStatus);
    if(url.pathname==="/api/biz/customer/getCustomerInfo")return response({organizations:[{organizationId:"org",projects:[{projectId:"project"}]}]});
    if(url.pathname.endsWith("/api_keys"))return response([{apiKey:"key-id",name:"zcode-api-key"}]);
    if(url.pathname.endsWith("/access_tokens")){
      await beforeIssue?.();
      return response({accessToken:projectToken,tokenType:"Bearer",expiresIn:3600,expiresAt:Math.ceil(Date.now()/1000)+3600});
    }
    throw new Error("Unexpected fixture request: "+url.pathname);
  }catch(error){console.error("Fixture HTTP error:",error);throw error}}};
  const resolver=()=>createCodingPlanApiKeyResolver({httpClient});
  const seed=async(user="desktop-user")=>store.saveMany({"oauth:active_provider":"zai","oauth:zai:access_token":businessToken,"oauth:zai:user_info":JSON.stringify({user_id:user}),zcodejwttoken:"desktop-jwt"});
  const input={providerId,accountAccess:{mode:"individual-coding-plan",accountType:"zai"}};
`;

for (const callback of [false, true]) test(`Z.AI ${callback ? "macOS callback" : "polling"} login publishes a token Desktop and CLI can both use`, async () => {
  await probe(`
    await loginZCodeCli({env,noBrowser:true,httpClient});
    assert.equal(await store.load("oauth:zai:access_token"),businessToken);
    assert.equal(await store.load("zcodejwttoken"),"fixture-zcode-jwt");
    assert.deepEqual(JSON.parse(await store.load("oauth:zai:user_info")),{user_id:"fixture-user"});
    const saved=await fs.readFile(store.filePath,"utf8");
    assert.ok(saved.includes("enc:v1:"));
    assert.ok(!saved.includes(businessToken)&&!saved.includes("fixture-oauth-token"));
    const desktop=await httpClient.request({url:"https://api.z.ai/api/biz/customer/getCustomerInfo",headers:{Authorization:"Bearer "+await store.load("oauth:zai:access_token")}});
    assert.equal(desktop.status,200);
    calls.length=0;
    const headers=createStandaloneProviderRuntimeHeadersPort(store,env,resolver());
    assert.equal((await headers.refreshBeforeModelRequest(input)).requestAuth.apiKey,projectToken);
    assert.ok(!calls.includes("/api/auth/z/login"));
  `, { callback });
}, 15_000);

test("a Desktop-only session authorizes CLI requests without a second login", async () => {
  await probe(`
    await seed();
    assert.equal(await store.load("account-provider:"+providerId+":identity"),null);
    const snapshot=await readStandaloneAccountProviderConfigSnapshot(store,env);
    assert.equal(snapshot.providers.entries().find(([id])=>id===providerId)[1].access.entitled,true);
    const headers=createStandaloneProviderRuntimeHeadersPort(store,env,resolver());
    assert.equal((await headers.refreshBeforeModelRequest(input)).requestAuth.apiKey,projectToken);
    assert.ok(!calls.includes("/api/auth/z/login"));
    assert.equal(await store.load("oauth:zai:access_token"),businessToken);
  `);
}, 15_000);

test("running CLI requests follow Desktop account changes and reject a late result after logout", async () => {
  await probe(`
    await seed();
    const headers=createStandaloneProviderRuntimeHeadersPort(store,env,resolver());
    const first=await headers.refreshBeforeModelRequest(input);
    businessToken="second-business-token";projectToken="second-project-token";
    await seed("second-user");
    const second=await headers.refreshBeforeModelRequest(input);
    assert.equal(second.requestAuth.apiKey,projectToken);
    assert.notEqual(first.requestAuth.accountScope,second.requestAuth.accountScope);
    await assert.rejects(headers.refreshBeforeModelRequest({...input,expectedAccountScope:first.requestAuth.accountScope}),/project_token_scope_invalidated/);
    headers.clearProjectTokens();
    beforeIssue=()=>store.delete("oauth:active_provider");
    await assert.rejects(headers.refreshBeforeModelRequest(input),/project_token_scope_invalidated/);
    await assert.rejects(headers.refreshBeforeModelRequest(input),/凭据已经失效/);
    assert.ok(!calls.includes("/api/auth/z/login"));
  `);
}, 15_000);

test("a rejected business exchange leaves the existing Desktop login intact", async () => {
  await probe(`
    await seed();
    const previous=await fs.readFile(store.filePath,"utf8");
    rejectExchange=true;
    await assert.rejects(loginZCodeCli({env,noBrowser:true,httpClient}),/project_token_login_failed/);
    assert.ok(await fs.readFile(store.filePath,"utf8")===previous,"failed login overwrote the shared Desktop session");
  `, { callback: true });
}, 15_000);

test("legacy CLI OAuth credentials migrate to Desktop's format after a confirmed exchange", async () => {
  await probe(`
    await seed("fixture-user");
    await store.save("oauth:zai:access_token","fixture-oauth-token");
    const headers=createStandaloneProviderRuntimeHeadersPort(store,env,resolver());
    const first=await headers.refreshBeforeModelRequest(input);
    assert.equal(first.requestAuth.apiKey,projectToken);
    assert.equal(await store.load("oauth:zai:access_token"),businessToken);
    assert.equal(calls.filter(path=>path==="/api/auth/z/login").length,1);
    calls.length=0;
    const second=await headers.refreshBeforeModelRequest(input);
    assert.equal(second.requestAuth.accountScope,first.requestAuth.accountScope);
    assert.ok(!calls.includes("/api/auth/z/login"));
  `);
}, 15_000);

test("legacy migration cannot overwrite a newer Desktop login", async () => {
  await probe(`
    await seed("fixture-user");
    await store.save("oauth:zai:access_token","fixture-oauth-token");
    beforeIssue=async()=>{businessToken="new-desktop-token";await seed("new-desktop-user")};
    const headers=createStandaloneProviderRuntimeHeadersPort(store,env,resolver());
    await assert.rejects(headers.refreshBeforeModelRequest(input),/project_token_scope_invalidated/);
    assert.equal(await store.load("oauth:zai:access_token"),"new-desktop-token");
    assert.equal(JSON.parse(await store.load("oauth:zai:user_info")).user_id,"new-desktop-user");
  `);
}, 15_000);

test("permission failures do not trigger legacy conversion or change the shared token", async () => {
  await probe(`
    await seed();
    await store.save("oauth:zai:access_token","fixture-oauth-token");
    rejectedStatus=403;
    const headers=createStandaloneProviderRuntimeHeadersPort(store,env,resolver());
    await assert.rejects(headers.refreshBeforeModelRequest(input),/project_token_http_403/);
    assert.ok(!calls.includes("/api/auth/z/login"));
    assert.equal(await store.load("oauth:zai:access_token"),"fixture-oauth-token");
  `);
}, 15_000);

test("cancelling macOS login after material resolution preserves the shared session", async () => {
  await probe(`
    await seed();
    const previous=await fs.readFile(store.filePath,"utf8"),controller=new AbortController();
    await assert.rejects(loginZCodeCli({env,noBrowser:true,httpClient,abortSignal:controller.signal,
      apiKeyResolver:{resolveMaterial:async()=>{controller.abort(new Error("fixture login cancelled"));return{zaiBusinessToken:businessToken}}}
    }),/fixture login cancelled/);
    assert.ok(await fs.readFile(store.filePath,"utf8")===previous);
  `, { callback: true });
}, 15_000);

test("a Desktop BigModel profile also supplies the CLI account identity", async () => {
  await probe(`
    const id="account:bigmodel-individual-coding-plan";
    await store.saveMany({"oauth:active_provider":"bigmodel","oauth:bigmodel:access_token":businessToken,
      "oauth:bigmodel:user_info":JSON.stringify({id:"desktop-bigmodel-user",username:"Fixture",displayName:"Fixture"}),zcodejwttoken:"desktop-jwt"});
    const snapshot=await readStandaloneAccountProviderConfigSnapshot(store,env);
    assert.equal(snapshot.providers.entries().find(([provider])=>provider===id)[1].access.entitled,true);
    assert.equal(snapshot.providers.entries().find(([provider])=>provider===providerId)[1].access.entitled,false);
    const headers=createStandaloneProviderRuntimeHeadersPort(store,env,resolver());
    const auth=await headers.refreshBeforeModelRequest({providerId:id,accountAccess:{mode:"individual-coding-plan",accountType:"bigmodel"}});
    assert.equal(auth.requestAuth.apiKey,projectToken);
    assert.ok(!calls.includes("/api/auth/z/login"));
  `);
}, 15_000);

test("request auth uses the resolved provider even when the original catalog path is unavailable", async () => {
  await probe(`
    await seed();
    const headers=createStandaloneProviderRuntimeHeadersPort(store,{...env,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:"/missing/fixture-catalog.json"},resolver());
    assert.equal((await headers.refreshBeforeModelRequest(input)).requestAuth.apiKey,projectToken);
  `);
}, 15_000);
