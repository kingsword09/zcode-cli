import { describe, expect, test } from "bun:test";

import {
  chooseArtifact,
  manifestUrl,
  parseArgs,
  patchRuntimeOAuthHttpErrors,
  patchRuntimeTuiBridge,
  patchRuntimeZaiDesktopOAuth
} from "../scripts/sync-runtime.ts";

describe("runtime synchronization", () => {
  test("parseArgs uses the CI-safe Linux default", () => {
    expect(parseArgs([])).toEqual({ platform: "linux", arch: "x64" });
    expect(parseArgs(["--platform", "win32", "--arch", "arm64"])).toEqual({
      platform: "win32",
      arch: "arm64"
    });
  });

  test("preserves the HTTP status when an OAuth error body is not JSON", () => {
    const runtime = [
      "class Rx extends Error{}",
      "async function Vqr(e,t,r){",
      "let o=await e.request(t,r),",
      "n=new TextDecoder().decode(o.body),i=oDo(n),s=O7(i);",
      "return s}",
      "function oDo(e){try{return JSON.parse(e)}catch{",
      "throw new Rx(\"OAuth response is not valid JSON\",{httpStatus:void 0})}}"
    ].join("");
    const patched = patchRuntimeOAuthHttpErrors(runtime);

    expect(patched).toContain("i=oDo(n,o.status)");
    expect(patched).toContain("OAuth HTTP error ${t} (empty or non-JSON response)");
    const parse = new Function(`${patched};return oDo;`)() as (body: string, status: number) => unknown;
    expect(() => parse("", 404)).toThrow("OAuth HTTP error 404 (empty or non-JSON response)");
    expect(() => parse("not-json", 200)).toThrow("OAuth response is not valid JSON");
    expect(patchRuntimeOAuthHttpErrors(patched)).toBe(patched);
    expect(patchRuntimeOAuthHttpErrors("upstream runtime without the legacy parser")).toBe(
      "upstream runtime without the legacy parser"
    );
    expect(() => patchRuntimeOAuthHttpErrors(
      'broken "OAuth response is not valid JSON",{httpStatus:void 0}'
    )).toThrow(/parser anchor/);
  });

  test("adds a Desktop authorization-code completion path while retaining official persistence", () => {
    const loginFunctions = [
      "async function sDo(e={}){",
      "let t=e.env??process.env,r=e.now??Date.now,o=e.sleep??fDo;",
      "F1(e.abortSignal);",
      "let i=e.credentialStore??cj({env:t}),s=dDo(e,t),u=await s.init({});",
      "let c=await mDo({});",
      "try{await i.saveZaiLoginCredentials({accessToken:c.zai.access_token,jwtToken:c.token,user:c.user})}",
      "catch(f){throw new Ox(\"credential_write_failed\",\"Login succeeded but writing credentials failed.\",{cause:f})}",
      "let d=await aGr({accessToken:c.zai.access_token,env:t,httpClient:e.httpClient,providerId:\"zai\",resolver:e.apiKeyResolver}),p;",
      "try{p=await qz({apiKey:d,filePath:e.userConfigPath,providerId:\"zai\"})}",
      "catch(f){throw new Ox(\"config_update_failed\",\"Login succeeded but updating ZCode config failed.\",{cause:f})}",
      "return{configPath:p.path}}",
      "async function uDo(e={}){let t=e.env??process.env;F1(e.abortSignal);",
      "let r=e.httpClient??iGr(t),o=e.state??Nqr();return r}"
    ].join("");
    const runtime = [
      "class Ox extends Error{}",
      "function F1(){}",
      "let saved=null,resolved=null,written=null;",
      "function cj(){return{filePath:'/credentials.json',async saveZaiLoginCredentials(value){saved=value}}}",
      "function iGr(){return{async request(){return{status:200,body:new TextEncoder().encode(JSON.stringify({code:0,data:{token:'jwt-token',zai:{access_token:'oauth-token'},user:{user_id:'user-1'}}}))}}}}",
      "async function aGr(value){resolved=value;return'coding-plan-key'}",
      "async function qz(value){written=value;return{path:'/config.json',mainModel:'zai/model'}}",
      loginFunctions
    ].join("");
    const patched = patchRuntimeZaiDesktopOAuth(runtime);

    expect(patched).toContain('ZCODE_CLI_OAUTH_CALLBACK_STDIN==="1"');
    expect(patched).toContain('url:"https://zcode.z.ai/api/v1/oauth/token"');
    expect(patched).toContain("i.saveZaiLoginCredentials");
    expect(patched).toContain("aGr({accessToken:$zAccessToken");
    expect(patched).toContain("qz({apiKey:$zApiKey");
    expect(() => new Function(patched)).not.toThrow();
    expect(patchRuntimeZaiDesktopOAuth(patched)).toBe(patched);
    expect(() => patchRuntimeZaiDesktopOAuth("incompatible runtime")).toThrow(/credential anchor/);

    const callback = JSON.stringify({
      callbackUrl: "zcode://zai-auth/callback?code=authorization-code&state=expected-state",
      state: "expected-state"
    });
    const load = new Function(
      "require",
      `${patched};return {login:sDo,read:()=>({resolved,saved,written})};`
    ) as (require: (id: string) => unknown) => {
      login(options: Record<string, unknown>): Promise<Record<string, unknown>>;
      read(): Record<string, unknown>;
    };
    const fixture = load((id) => {
      if (id !== "node:fs") throw new Error(`Unexpected module: ${id}`);
      return { readFileSync: () => callback };
    });
    return fixture.login({
      env: { ZCODE_CLI_OAUTH_CALLBACK_STDIN: "1" }
    }).then((result) => {
      expect(result).toMatchObject({
        configPath: "/config.json",
        credentialsPath: "/credentials.json",
        model: "zai/model",
        providerId: "zai"
      });
      expect(fixture.read()).toMatchObject({
        resolved: { accessToken: "oauth-token", providerId: "zai" },
        saved: { accessToken: "oauth-token", jwtToken: "jwt-token" },
        written: { apiKey: "coding-plan-key", providerId: "zai" }
      });
    });
  });

  test("manifestUrl maps supported updater channels", () => {
    expect(manifestUrl("linux", "x64")).toMatch(/update\/linux\/x64\/latest-linux\.yml$/);
    expect(manifestUrl("darwin", "arm64")).toMatch(/update\/mac\/arm64\/latest-mac\.yml$/);
    expect(manifestUrl("win32", "x64")).toMatch(/update\/win\/x64\/latest\.yml$/);
  });

  test("chooseArtifact selects an extractable installer", () => {
    const manifest = {
      files: [
        { url: "ZCode.AppImage", sha512: "one" },
        { url: "ZCode.deb", sha512: "two" }
      ]
    };
    expect(chooseArtifact(manifest, "linux").url).toBe("ZCode.deb");
    expect(() => chooseArtifact({ files: [] }, "linux")).toThrow(/No \.deb artifact/);
  });

  test("injects transcript and structured state readers into the official TUI adapter", () => {
    const runtime = [
      "E.sendInput=async(A,$)=>{return Kvt(await S(),D,O1(t))},",
      "E.recallPreviousInput=async A=>await(await S()).recallPreviousInputHistory?.(A)??null,",
      "CVr(E,S,r);",
      "return c({recallPreviousInput:g.recallPreviousInput,sendInput:g.sendInput,submitPrompt:g})"
    ].join("");
    const runtimeWithApp = runtime.replace(
      "E.sendInput",
      'loadSessionTranscript:a(async()=>await dUr({sessionId:e.sessionId,sessionStore:e.sessionStore}),"loadSessionTranscript"),readTodos:E.sendInput'
    );
    const patched = patchRuntimeTuiBridge(runtimeWithApp);

    expect(patched).toContain("E.loadSessionTranscript=async()=>await(await S()).loadSessionTranscript?.()??[]");
    expect(patched).toContain("E.readGoal=async()=>await(await S()).readTarget?.()??null");
    expect(patched).toContain("E.readTodos=async()=>await(await S()).readTodos?.()??[]");
    expect(patched).toContain("E.readRuntimeProjection=async()=>{let e=await S();return e.runtime?.getProjection?.()??null}");
    expect(patched).toContain("E.readSessionUsage=async()=>await(await S()).readSessionUsage?.()??null");
    expect(patched).toContain("E.cancelBackgroundTask=async e=>await(await S()).cancelBackgroundTask?.(e)??null");
    expect(patched).toContain("loadSessionTranscript:g.loadSessionTranscript");
    expect(patched).toContain("readGoal:g.readGoal");
    expect(patched).toContain("readTodos:g.readTodos");
    expect(patched).toContain("readRuntimeProjection:g.readRuntimeProjection");
    expect(patched).toContain("readSessionUsage:g.readSessionUsage");
    expect(patched).toContain("cancelBackgroundTask:g.cancelBackgroundTask");
    expect(patched).toContain("sessionStore.queryTaskUsage?.({sessionID:e.sessionId})");
    expect(patchRuntimeTuiBridge(patched)).toBe(patched);
    expect(() => patchRuntimeTuiBridge("incompatible runtime")).toThrow(/incompatible/);
  });
});
