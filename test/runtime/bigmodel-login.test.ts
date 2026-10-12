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
        "startProcessProviderRegistryRuntime", "parseClientSigningCredential", "buildLoginSelection", "openUrlInBrowser"];
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

test("BigModel OAuth completes native polling and stores OAuth credentials without a derived API key", async () => {
  await probe(`
    const assert = require("node:assert/strict");
    const fs = require("node:fs/promises");
    const env = {...process.env};
    const choices=buildLoginSelection("en").items;
    assert.equal(choices.some(item=>item.id==="bigmodel-coding-plan"),true);
    assert.equal(choices.find(item=>item.id==="bigmodel-coding-plan-api-key").input.mask,true);
    let requested = false, materialRequests = 0, browserOpened = false;
    const response=data=>({status:200,body:new TextEncoder().encode(JSON.stringify({code:0,data}))});
    const result = await loginBigmodelCodingPlan({env, pollToken:"fixture-poll-token",
      openBrowser:authorizeUrl=>openUrlInBrowser(authorizeUrl,{platform:"win32",spawnProcess:(executable,args,options)=>{
        assert.equal(executable,"powershell.exe");
        assert.deepEqual(args.slice(0,3),["-NoProfile","-NonInteractive","-EncodedCommand"]);
        const script=Buffer.from(args[3],"base64").toString("utf16le");
        const encodedUrl=/FromBase64String\\('([A-Za-z0-9+/=]+)'\\)/u.exec(script)?.[1];
        assert.ok(encodedUrl);
        assert.equal(Buffer.from(encodedUrl,"base64").toString("utf8"),authorizeUrl);
        assert.equal(options.windowsHide,true);
        assert.equal(options.detached,false);
        browserOpened=true;
        const child=new (require("node:events").EventEmitter)();
        child.unref=()=>{};
        process.nextTick(()=>child.emit("spawn"));
        return child;
      }}),
      onAuthorizeUrl:async({authorize_url,flow_id})=>{
        assert.equal(authorize_url,"https://bigmodel.test/authorize");
        assert.equal(flow_id,"fixture-flow");
      },
      apiKeyResolver:{resolveMaterial:async(input)=>{
        materialRequests++;
        assert.equal(input.accessToken,"fixture-token");
        assert.equal(input.family,"bigmodel");
        return {organizationId:"org",projectId:"project",token:"temporary-project-token",apiKeyId:"fixture-id"};
      }},
      httpClient:{request:async(request)=>{
        const url=new URL(request.url);
        assert.equal(url.origin,"https://zcode.z.ai");
        assert.equal(request.headers.Authorization,"Bearer fixture-poll-token");
        if(url.pathname==="/api/v1/oauth/cli/init"){
          assert.equal(request.method,"POST");
          assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body)),{provider:"bigmodel"});
          return response({authorize_url:"https://bigmodel.test/authorize",flow_id:"fixture-flow",expires_at:Math.ceil(Date.now()/1000)+60,poll_interval_sec:1});
        }
        if(url.pathname==="/api/v1/oauth/cli/poll/fixture-flow"){
          requested=true;
          assert.equal(request.method,"GET");
          return response({status:"ready",token:"fixture-jwt",user:{user_id:"fixture-user",name:"Fixture"},bigmodel:{access_token:"fixture-token",refresh_token:"fixture-refresh"}});
        }
        throw new Error("Unexpected login request: "+url.pathname);
      }}
    });
    assert.equal(requested,true);
    assert.equal(browserOpened,true);
    assert.equal(result.browser.opened,true);
    assert.equal(materialRequests,1);
    assert.equal(result.providerId,"bigmodel");
    const store=createSharedZCodeCredentialStore({env});
    const raw=await fs.readFile(store.filePath,"utf8");
    assert.equal(raw.includes("enc:v1:"),true);
    assert.equal(raw.includes("fixture-id.fixture-secret"),false);
    assert.equal(raw.includes("fixture-jwt"),false);
    assert.equal(raw.includes("temporary-project-token"),false);
    assert.equal(await store.load("zcodejwttoken"),"fixture-jwt");
    assert.equal(await store.load("oauth:bigmodel:refresh_token"),"fixture-refresh");
    const host=await startProcessProviderRegistryRuntime(env,{standalone:{}});
    try {
      const providerId="account:bigmodel-individual-coding-plan";
      assert.equal(host.configuredDefaultModelSelection.providerId,providerId);
      assert.equal(await store.load("account-provider:"+providerId+":auth-source"),"oauth");
    } finally {host.dispose();}
    console.log("BIGMODEL_LOGIN_OK");
  `);
}, 15_000);

test("a rejected BigModel polling initialization does not save credentials", async () => {
  await probe(`
    const assert=require("node:assert/strict");
    let saved=false;
    await assert.rejects(loginBigmodelCodingPlan({env:process.env,noBrowser:true,
      httpClient:{request:async()=>({status:401,body:new TextEncoder().encode(JSON.stringify({msg:"Expired code"}))})},
      credentialStore:{load:async()=>null,saveMany:async()=>{saved=true;}},
      apiKeyResolver:{resolveMaterial:async()=>{throw new Error("Resolved material after a rejected initialization");}}
    }),/OAuth HTTP error 401/);
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
        const auth=await host.providerRuntimeHeadersPort.refreshBeforeModelRequest({providerId,accountAccess:{mode:"individual-coding-plan",accountType:family}});
        assert.equal(auth.requestAuth.apiKey,"fixture-id.fixture-secret");
        assert.ok(parseClientSigningCredential(auth.requestAuth.apiKey));
        const wrongStore=createSharedZCodeCredentialStore({env:{...env,ZCODE_CREDENTIAL_SECRET:"wrong-secret"}});
        await assert.rejects(wrongStore.load("account-provider:"+providerId+":identity"),/Credential decrypt failed/);
      } finally {host.dispose();}
    }
    console.log("BIGMODEL_LOGIN_OK");
  `);
}, 15_000);
