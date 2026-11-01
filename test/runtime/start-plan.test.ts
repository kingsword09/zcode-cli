import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "acorn";
import { hasRuntimeStartPlan, patchRuntimeStartPlan } from "../../scripts/runtime-start-plan-patches.ts";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

const root = join(import.meta.dir, "../..");
const fixture = `
async function catalog(e,t){return{zcodeBuiltinRevision:t.revision,providers:t.providers.entries().flatMap(([i,a])=>{let c=a.access,u=a.builtinModelIds?.find(f=>f.trim())?.trim();return c?.type==="zhipu-account"&&c.mode==="individual-coding-plan"&&c.accountType&&u?[{family:c.accountType,modelId:u,providerId:i}]:[]})}}
label(catalog,"readStandaloneCodingPlanCatalog");
async function resolve(e,t){let n=(await catalog(t)).filter(o=>o.family===e);if(n.length!==1)throw new Error("ambiguous provider");return n[0]}
label(resolve,"resolveStandaloneCodingPlanProvider");
async function snapshot(e,t,n){let o=await catalog(t,n),i=o.providers,a=i.map(({providerId:S})=>S),v=new Providers(i.map(({providerId:k})=>[k,new Config({access:new Access({entitled:!0})})]));return assemble(o.zcodeBuiltinRevision,v)}
label(snapshot,"readStandaloneAccountProviderConfigSnapshot");
function headers(e){return{async refreshBeforeModelRequest(c){let u=c.providerId.trim(),f=c.accountAccess;if(!f||f.mode!=="individual-coding-plan")throw new Error("invalid mode");return exchange(e,u)}}}
label(headers,"createStandaloneProviderRuntimeHeadersPort");
`;

test("Start Plan patch separates catalog, login, account projection and auth and is idempotent", () => {
  expect(hasRuntimeStartPlan(fixture)).toBe(false);
  const patched = patchRuntimeStartPlan(fixture);
  expect(hasRuntimeStartPlan(patched)).toBe(true);
  expect(patchRuntimeStartPlan(patched)).toBe(patched);
  expect(() => parse(patched, { ecmaVersion: "latest" })).not.toThrow();
  expect(patched).toContain('o.mode==="individual-coding-plan"');
  expect(patched).toContain('.filter($zProvider=>$zProvider.mode!=="start-plan")');
  expect(patched).toContain('.refreshStandaloneStartPlanRequest(e,c)');
  expect(patched).not.toContain("-start-plan$");
});

test.each([
  fixture.replace('c.mode==="individual-coding-plan"', 'c.mode==="changed"'),
  fixture.replace('.filter(o=>o.family===e)', '.filter(o=>o.family!==e)'),
  fixture.replace('i=o.providers,', 'i=o.changed,'),
  fixture.replace('f=c.accountAccess;', 'f=c.changed;'),
  fixture + fixture,
])("shape drift or ambiguous anchors fail without a partial patch", runtime => {
  expect(() => patchRuntimeStartPlan(runtime)).toThrow("incompatible");
  expect(hasRuntimeStartPlan(runtime)).toBe(false);
});

test("a partial marker does not falsely advertise full support", () => {
  const partial = fixture.replace('c.mode==="individual-coding-plan"', '(c.mode==="individual-coding-plan"||c.mode==="start-plan")');
  expect(hasRuntimeStartPlan(partial)).toBe(false);
  expect(() => patchRuntimeStartPlan(partial)).toThrow("incompatible");
});

async function probe(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-start-plan-"));
  try {
    const file = join(root, "vendor/zcode.cjs");
    const source = await readFile(file, "utf8");
    const names = ["createSharedZCodeCredentialStore", "readStandaloneAccountProviderConfigSnapshot",
      "createStandaloneProviderRuntimeHeadersPort", "resolveStandaloneCodingPlanProvider"];
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
      + `await(async(${names.join(",")})=>{${setup}${body};console.log("START_PLAN_OK")})(${symbols.map(value => value.symbol).join(",")}).catch(error=>{console.error(error.stack);process.exitCode=1});return;`;
    const script = `const fs=require("node:fs"),Module=require("node:module"),path=require("node:path");
      const file=${JSON.stringify(file)},runtime=new Module(file,module);
      runtime.filename=file;runtime.paths=Module._nodeModulePaths(path.dirname(file));
      runtime._compile(fs.readFileSync(file,"utf8").replace(${JSON.stringify(main[0])},${JSON.stringify(main[0] + injected)}),file);`;
    const child = Bun.spawn([Bun.which("node")!, "--eval", script], {
      cwd: directory,
      env: { ...runtimeTestEnv(directory), ZCODE_CREDENTIAL_SECRET: "start-plan-test-secret" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr || stdout).toBe(0);
      expect(stdout).toContain("START_PLAN_OK");
    } finally { clearTimeout(timer); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const setup = `
  const assert=require("node:assert/strict"),crypto=require("node:crypto");
  globalThis.fetch=()=>{throw new Error("Unexpected HTTP request")};
  const env={...process.env},store=createSharedZCodeCredentialStore({env});
  const expiresAt=Math.floor(Date.now()/1000)+3600;
  const jwt=(user="desktop-user",exp=expiresAt)=>"e30."+Buffer.from(JSON.stringify({sub:user,exp})).toString("base64url")+".fixture-signature";
  const seed=async(family="zai",user="desktop-user")=>store.saveMany({"oauth:active_provider":family,["oauth:"+family+":user_info"]:JSON.stringify({user_id:user}),zcodejwttoken:jwt(user)});
  const input=(family="zai")=>({providerId:"account:"+family+"-start-plan",accountAccess:{mode:"start-plan",accountType:family}});
  const resolver={clear(){},resolveMaterial(){throw new Error("Start Plan must not exchange a Coding Plan token")}};
  const port=()=>createStandaloneProviderRuntimeHeadersPort(store,env,resolver);
  const entitled=async(id)=>{const snapshot=await readStandaloneAccountProviderConfigSnapshot(store,env);return snapshot.providers.entries().find(([key])=>key===id)?.[1].access.entitled};
`;

for (const family of ["zai", "bigmodel"]) test(`native ${family} Start Plan works with only the shared Desktop session`, async () => {
  await probe(`
    await seed(${JSON.stringify(family)});
    const request=input(${JSON.stringify(family)});
    assert.equal(await store.load("account-provider:"+request.providerId+":identity"),null);
    assert.equal(await entitled(request.providerId),true);
    const result=await port().refreshBeforeModelRequest(request);
    assert.equal(result.requestAuth.apiKey,jwt());
    assert.match(result.requestAuth.accountScope,/^[a-f0-9]{64}$/);
    assert.equal(result.requestAuth.apiKeyId,undefined);
    const coding=await resolveStandaloneCodingPlanProvider(${JSON.stringify(family)},env);
    assert.equal(coding.providerId,"account:"+${JSON.stringify(family)}+"-individual-coding-plan");
  `);
}, 15_000);

test("native Start Plan follows Desktop switches without stale identities or manual keys", async () => {
  await probe(`
    await seed();
    await store.saveMany({"account-provider:account:zai-individual-coding-plan:identity":"old-cli-user","account-provider:account:zai-individual-coding-plan:auth-source":"manual"});
    const headers=port(),first=await headers.refreshBeforeModelRequest(input());
    await seed("zai","second-user");
    const second=await headers.refreshBeforeModelRequest(input());
    assert.equal(second.requestAuth.apiKey,jwt("second-user"));
    assert.notEqual(first.requestAuth.accountScope,second.requestAuth.accountScope);
    await assert.rejects(headers.refreshBeforeModelRequest({...input(),expectedAccountScope:first.requestAuth.accountScope}),/project_token_scope_invalidated/);
    await seed("bigmodel","bigmodel-user");
    assert.equal(await entitled(input().providerId),false);
    assert.equal(await entitled(input("bigmodel").providerId),true);
    await assert.rejects(headers.refreshBeforeModelRequest(input()),/start_plan_login_required/);
    assert.equal((await headers.refreshBeforeModelRequest(input("bigmodel"))).requestAuth.apiKey,jwt("bigmodel-user"));
  `);
}, 15_000);

test("native Start Plan never substitutes a Coding Plan token for a missing or expired JWT", async () => {
  await probe(`
    await seed();
    await store.save("oauth:zai:access_token","coding-business-token");
    const headers=port();
    for(const value of ["", "project-token", jwt("desktop-user",1)]){
      if(value)await store.save("zcodejwttoken",value);else await store.delete("zcodejwttoken");
      assert.equal(await entitled(input().providerId),false);
      await assert.rejects(headers.refreshBeforeModelRequest(input()),/start_plan_login_required/);
    }
    await seed();
    const first=await headers.refreshBeforeModelRequest(input());
    await store.delete("oauth:active_provider");
    assert.equal(await entitled(input().providerId),false);
    await assert.rejects(headers.refreshBeforeModelRequest({...input(),expectedAccountScope:first.requestAuth.accountScope}),/project_token_scope_invalidated/);
  `);
}, 15_000);

test("native Start Plan rejects an unchanged JWT after a server rejection", async () => {
  await probe(`
    await seed();
    const headers=port(),first=await headers.refreshBeforeModelRequest(input());
    const fingerprint=crypto.createHash("sha256").update(first.requestAuth.apiKey).digest("hex");
    await assert.rejects(headers.refreshBeforeModelRequest({...input(),expectedAccountScope:first.requestAuth.accountScope,rejectedProjectTokenFingerprint:fingerprint}),/start_plan_session_rejected/);
  `);
}, 15_000);

test("native model projection and request auth accept shared ZCode JWTs without exp", async () => {
  await probe(`
    await seed();
    const token="e30."+Buffer.from(JSON.stringify({sub:"desktop-user"})).toString("base64url")+".fixture-signature";
    await store.save("zcodejwttoken",token);
    assert.equal(await entitled(input().providerId),true);
    assert.equal((await port().refreshBeforeModelRequest(input())).requestAuth.apiKey,token);
  `);
}, 15_000);

test("synced runtime ships complete, idempotent Start Plan support", async () => {
  const runtime = await readFile(join(root, "vendor/zcode.cjs"), "utf8");
  expect(hasRuntimeStartPlan(runtime)).toBe(true);
  expect(patchRuntimeStartPlan(runtime)).toBe(runtime);
});
