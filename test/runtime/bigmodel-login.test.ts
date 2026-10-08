import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

const root = join(import.meta.dir, "../..");

/** Use the real login, encrypted credential store and request-auth port in an isolated Node process. */
async function probe(body: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-bigmodel-login-"));
  try {
    const builtinPath = join(home, "builtin.json");
    await writeFile(builtinPath, await readFile(join(root, "vendor/provider/zcode-builtin.json")));
    const script = `
      const fs = require("node:fs"), Module = require("node:module"), path = require("node:path");
      const file = ${JSON.stringify(join(root, "vendor/zcode.cjs"))};
      let source = fs.readFileSync(file, "utf8");
      const names = ["loginBigmodelCodingPlan", "configureCodingPlanApiKey", "createSharedZCodeCredentialStore",
        "startProcessProviderRegistryRuntime", "parseClientSigningCredential", "buildLoginSelection"];
      const symbols = names.map(name => {
        const symbol = new RegExp('[A-Za-z_$][\\\\w$]*\\\\(([A-Za-z_$][\\\\w$]*),"' + name + '"\\\\)', 'u').exec(source);
        if (!symbol) throw new Error("Missing native function: " + name);
        const init = [...source.slice(0, symbol.index).matchAll(/([A-Za-z_$][\\w$]*)=[A-Za-z_$][\\w$]*\\(\\(\\)=>\\{/gu)].at(-1)?.[1];
        if (!init) throw new Error("Missing native initializer: " + name);
        return { symbol: symbol[1], init };
      });
      const main = /async function [A-Za-z_$][\\w$]*\\(\\)\\{let [A-Za-z_$][\\w$]*=process\\.argv\\.slice\\(2\\);/u.exec(source);
      if (!main) throw new Error("Missing native entry point");
      source = source.replace(main[0], main[0] + symbols.map(s => s.init + "();").join("")
        + "await(async(" + names.join(",") + ")=>{" + ${JSON.stringify(body)} + "})(" + symbols.map(s => s.symbol).join(",") + ");return;");
      const runtime = new Module(file, module);
      runtime.filename = file;
      runtime.paths = Module._nodeModulePaths(path.dirname(file));
      runtime._compile(source, file);
    `;
    const child = Bun.spawn([Bun.which("node")!, "--eval", script], {
      cwd: home, env: { ...runtimeTestEnv(home), ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath },
      stdout: "pipe", stderr: "pipe"
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr || stdout).toBe(0);
    expect(stdout).toContain("BIGMODEL_LOGIN_OK");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("BigModel OAuth completes the native callback, broker exchange and account setup without an app secret", async () => {
  await probe(`
    const assert = require("node:assert/strict");
    const fs = require("node:fs/promises");
    const env = {...process.env};
    const choices=buildLoginSelection("en").items;
    assert.equal(choices.some(item=>item.id==="bigmodel-coding-plan"),true);
    assert.equal(choices.find(item=>item.id==="bigmodel-coding-plan-api-key").input.mask,true);
    let callbackUrl, requested = false, businessRequests = 0;
    const response=data=>({status:200,body:new TextEncoder().encode(JSON.stringify({code:0,data}))});
    const result = await loginBigmodelCodingPlan({env, noBrowser:true, state:"fixture-state",
      onAuthorizeUrl:async({authorize_url,callback_url})=>{
        callbackUrl=callback_url;
        const url=new URL(authorize_url);
        assert.equal(url.searchParams.get("appId"),"zcode");
        assert.equal(url.searchParams.get("state"),"fixture-state");
        assert.equal(url.searchParams.get("redirect"),callbackUrl);
        const callback=new URL(callbackUrl);
        callback.searchParams.set("authCode","fixture-code");
        callback.searchParams.set("state","wrong-state");
        const rejected=await fetch(callback);await rejected.text();
        assert.equal(rejected.status,400);
        callback.searchParams.set("state","fixture-state");
        const accepted=await fetch(callback);await accepted.text();
        assert.equal(accepted.status,200);
      },
      httpClient:{request:async(request)=>{
        const url=new URL(request.url);
        if(url.pathname==="/api/v1/oauth/token"){
          requested=true;
          assert.equal(url.origin,"https://zcode.z.ai");
          assert.equal(request.method,"POST");
          assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body)),{provider:"bigmodel",code:"fixture-code",redirect_uri:callbackUrl,state:"fixture-state"});
          return response({token:"fixture-jwt",bigmodel:{access_token:"fixture-token",refresh_token:"fixture-refresh"}});
        }
        businessRequests++;
        assert.equal(request.headers.Authorization,"fixture-token");
        assert.equal(request.method,"GET");
        if(url.pathname==="/api/biz/customer/getCustomerInfo")return response({organizations:[{organizationId:"org",projects:[{projectId:"project"}]}]});
        if(url.pathname.endsWith("/api_keys"))return response([{name:"zcode-api-key",apiKey:"fixture-id"}]);
        if(url.pathname.endsWith("/api_keys/copy/fixture-id"))return response({secretKey:"fixture-secret"});
        throw new Error("Unexpected login request: "+url.pathname);
      }}
    });
    assert.equal(requested,true);
    assert.equal(businessRequests,3);
    assert.equal(result.providerId,"bigmodel");
    const store=createSharedZCodeCredentialStore({env});
    const raw=await fs.readFile(store.filePath,"utf8");
    assert.equal(raw.includes("enc:v1:"),true);
    assert.equal(raw.includes("fixture-id.fixture-secret"),false);
    assert.equal(raw.includes("fixture-jwt"),false);
    assert.equal(await store.load("zcodejwttoken"),"fixture-jwt");
    assert.equal(await store.load("oauth:bigmodel:refresh_token"),"fixture-refresh");
    const host=await startProcessProviderRegistryRuntime(env,{standalone:{}});
    try {
      const providerId="account:bigmodel-individual-coding-plan";
      const auth=await host.providerRuntimeHeadersPort.refreshBeforeModelRequest({providerId,accountAccess:{mode:"individual-coding-plan"}});
      assert.equal(auth.requestAuth.apiKey,"fixture-id.fixture-secret");
      assert.ok(parseClientSigningCredential(auth.requestAuth.apiKey));
      assert.equal(host.configuredDefaultModelSelection.providerId,providerId);
    } finally {host.dispose();}
    console.log("BIGMODEL_LOGIN_OK");
  `);
}, 15_000);

test("a rejected BigModel broker exchange closes the callback and does not save credentials", async () => {
  await probe(`
    const assert=require("node:assert/strict");
    let closed=false,saved=false;
    await assert.rejects(loginBigmodelCodingPlan({env:process.env,noBrowser:true,state:"fixture-state",
      callbackServer:{callbackUrl:"http://127.0.0.1:54321/callback",waitForCallback:async()=>({code:"expired-code"}),close:async()=>{closed=true;}},
      httpClient:{request:async()=>({status:401,body:new TextEncoder().encode(JSON.stringify({msg:"Expired code"}))})},
      credentialStore:{saveMany:async()=>{saved=true;}},
      apiKeyResolver:{resolve:async()=>{throw new Error("Resolved an API key after a rejected exchange");}}
    }),/BigModel OAuth HTTP 401/);
    assert.equal(closed,true);
    assert.equal(saved,false);
    console.log("BIGMODEL_LOGIN_OK");
  `);
}, 15_000);

test("manual Coding Plan setup decrypts stored credentials for signing and rejects a mismatched encryption secret", async () => {
  await probe(`
    const assert = require("node:assert/strict"), fs = require("node:fs/promises");
    for (const family of ["bigmodel","zai"]) {
      const env={...process.env,ZCODE_CREDENTIAL_SECRET:"fixture-encryption-secret"};
      await configureCodingPlanApiKey({env,providerId:family,apiKey:"fixture-id.fixture-secret"});
      const store=createSharedZCodeCredentialStore({env});
      const raw=await fs.readFile(store.filePath,"utf8");
      assert.equal(raw.includes("fixture-id.fixture-secret"),false);
      assert.equal(raw.includes("enc:v1:"),true);
      const host=await startProcessProviderRegistryRuntime(env,{standalone:{}});
      try {
        const providerId="account:"+family+"-individual-coding-plan";
        const auth=await host.providerRuntimeHeadersPort.refreshBeforeModelRequest({providerId,accountAccess:{mode:"individual-coding-plan"}});
        assert.equal(auth.requestAuth.apiKey,"fixture-id.fixture-secret");
        assert.ok(parseClientSigningCredential(auth.requestAuth.apiKey));
        const wrongStore=createSharedZCodeCredentialStore({env:{...env,ZCODE_CREDENTIAL_SECRET:"wrong-secret"}});
        await assert.rejects(wrongStore.load("account-provider:"+providerId+":identity"),/Credential decrypt failed/);
      } finally {host.dispose();}
    }
    console.log("BIGMODEL_LOGIN_OK");
  `);
}, 15_000);
