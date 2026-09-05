import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  applyRuntimePatchPlan,
  chooseArtifact,
  extractRuntimeCapabilities,
  formatRuntimeCompatibilityFailure,
  hasRuntimeCliHelpContract,
  hasRuntimeHttpNoContentGuard,
  hasRuntimeNetworkRetryGuard,
  hasRuntimeStreamEofFinishGuard,
  manifestUrl,
  parseArgs,
  parseRuntimePatchReports,
  parseRuntimeLock,
  patchRuntimeAgentAutoBackground,
  patchRuntimeCliHelpContract,
  patchRuntimeDetachedAgentLifecycle,
  patchRuntimeGoalFailurePause,
  patchRuntimeHttpNoContent,
  patchRuntimeLoginModelDefaults,
  patchRuntimeNetworkRetryClassification,
  patchRuntimeOAuthHttpErrors,
  patchRuntimeStreamEofFinishGuard,
  patchRuntimeTerminalToolProjection,
  patchRuntimeTuiBridge,
  patchRuntimeZaiDesktopOAuth,
  resolveArtifactUrl,
  resolveLatestRuntimeLock,
  selectRuntimeLock,
  serviceManifestUrl,
  serviceReleasePlatform,
  supportsMultiMessageFileRewind,
  writeRuntimeCompatibilityFailure
} from "../scripts/sync-runtime.ts";
import {
  compareReleaseVersions,
  nextBuildVersion,
  parseReleaseVersion,
  syncedReleaseVersion
} from "../scripts/release-version.ts";

describe("runtime synchronization", () => {
  test("pins the exact remote runtime used by release workflows", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const lock = await Bun.file(new URL("../zcode-runtime.lock.json", import.meta.url)).json();
    const release = parseReleaseVersion(String(packageJson.version));

    expect(lock).toMatchObject({
      schemaVersion: 1,
      appVersion: release?.appVersion,
      platform: "linux",
      arch: "x64"
    });
    expect(lock.url).toMatch(/^https:\/\/cdn-zcode\.z\.ai\/.+\.deb$/u);
    expect(Buffer.from(String(lock.sha512), "base64")).toHaveLength(64);
    expect(packageJson.files).toContain("zcode-runtime.lock.json");
  });

  test("keeps the CLI build revision while aligning the App version", () => {
    expect(parseReleaseVersion("3.3.5-12")).toEqual({ appVersion: "3.3.5", build: 12 });
    expect(parseReleaseVersion("3.3.5+build.12")).toBeUndefined();
    expect(parseReleaseVersion("3.3.5-build.12")).toBeUndefined();
    expect(syncedReleaseVersion("3.3.5", "3.3.5-12")).toBe("3.3.5-12");
    expect(syncedReleaseVersion("3.4.0", "3.3.5-12")).toBe("3.4.0-12");
    expect(syncedReleaseVersion("3.4.0", "3.3.5")).toBe("3.4.0-1");
    expect(nextBuildVersion("3.4.0-12")).toBe("3.4.0-13");
    expect(compareReleaseVersions("3.3.5-13", "3.3.5-12")).toBe(1);
    expect(compareReleaseVersions("3.4.0-1", "3.3.5-99")).toBe(1);
    expect(compareReleaseVersions("3.3.5-12", "3.4.0-1")).toBe(-1);
    expect(compareReleaseVersions("3.3.5-12", "3.3.5-12")).toBe(0);
    expect(() => syncedReleaseVersion("3.4", "3.3.5-12")).toThrow(/Unsupported/);
  });

  test("parseArgs uses the CI-safe Linux default", () => {
    expect(parseArgs([])).toEqual({ platform: "linux", arch: "x64" });
    expect(parseArgs(["--platform", "win32", "--arch", "arm64"])).toEqual({
      platform: "win32",
      arch: "arm64"
    });
    expect(parseArgs(["--lock", "zcode-runtime.lock.json"])).toEqual({
      platform: "linux",
      arch: "x64",
      lock: "zcode-runtime.lock.json"
    });
    expect(() => parseArgs(["--app", "/tmp/ZCode.app", "--lock", "runtime.json"])).toThrow(/cannot/);
    expect(() => parseArgs(["--version", "3.3.5"])).toThrow(/--app/);
  });

  test("extracts launcher option capabilities from the strict global parser", () => {
    const runtime = 'parse=s(e=>parseArgs({options:{help:{short:"h",type:"boolean"},json:{type:"boolean"},"output-format":{type:"string"},prompt:{short:"p",type:"string"},attach:{multiple:!0,type:"string"},surface:{type:"string"},version:{short:"v",type:"boolean"}},strict:!0}),"parseGlobalArgs")';
    expect(extractRuntimeCapabilities(runtime)).toEqual({
      schemaVersion: 1,
      cli: {
        globalOptions: {
          help: { type: "boolean" },
          json: { type: "boolean" },
          "output-format": { type: "string" },
          prompt: { type: "string" },
          attach: { type: "string", multiple: true },
          surface: { type: "string" },
          version: { type: "boolean" }
        }
      }
    });
    expect(() => extractRuntimeCapabilities("incompatible runtime")).toThrow(/global parser anchor/);
  });

  test("hides help options that are absent from the extracted parser contract", () => {
    const runtime = [
      "Options:",
      "  --settings <path>  Load settings",
      "  --max-turns <n>  Maximum turns",
      "  --mode <mode>  Permission mode",
      "  --surface <surface>  Presentation surface",
      "",
      'parse=s(e=>parseArgs({options:{help:{type:"boolean"},"max-turns":{type:"string"},mode:{type:"string"},prompt:{type:"string"},surface:{type:"string"},version:{type:"boolean"}},strict:!0}),"parseGlobalArgs")'
    ].join("\n");

    const patched = patchRuntimeCliHelpContract(runtime);
    expect(patched).not.toContain("--settings");
    expect(patched).toContain("--max-turns <n>");
    expect(patched).toContain("--surface <surface>");
    expect(hasRuntimeCliHelpContract(patched)).toBeTrue();
    expect(patchRuntimeCliHelpContract(patched)).toBe(patched);
  });

  test("validates locked runtime inputs before downloading", () => {
    const lock = {
      schemaVersion: 1,
      appVersion: "3.3.5",
      platform: "linux",
      arch: "x64",
      url: "https://example.com/zcode.deb",
      sha512: Buffer.alloc(64, 7).toString("base64")
    } as const;
    expect(parseRuntimeLock(lock)).toEqual(lock);
    expect(() => parseRuntimeLock({ ...lock, url: "http://example.com/zcode.deb" })).toThrow(/HTTPS/);
    expect(() => parseRuntimeLock({ ...lock, sha512: `${lock.sha512.slice(0, -2)}!!` })).toThrow(/SHA-512/);
  });

  test("does not downgrade a newer lock when a release manifest lags behind", () => {
    const candidate = parseRuntimeLock({
      schemaVersion: 1,
      appVersion: "3.6.5",
      platform: "linux",
      arch: "x64",
      url: "https://example.com/3.6.5.deb",
      sha512: Buffer.alloc(64, 6).toString("base64")
    });
    const current = parseRuntimeLock({
      ...candidate,
      appVersion: "3.7.3",
      url: "https://example.com/3.7.3.deb",
      sha512: Buffer.alloc(64, 7).toString("base64")
    });

    expect(selectRuntimeLock(candidate, current)).toBe(current);
    expect(selectRuntimeLock(current, candidate)).toBe(current);
    expect(selectRuntimeLock(candidate, { ...current, arch: "arm64" })).toBe(candidate);
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

  test("constructs bodyless Fetch responses for 204, 205, and 304", async () => {
    const runtime = [
      'function request(response,headers){return new Response(streams.Readable.toWeb(response),{headers:headers,status:response.statusCode??502,statusText:response.statusMessage})}',
      'function proxied(response,headers){return new Response(other.Readable.toWeb(response),{headers:headers,status:response.statusCode??502,statusText:response.statusMessage})}'
    ].join("");
    const patched = patchRuntimeHttpNoContent(runtime);
    expect(hasRuntimeHttpNoContentGuard(runtime)).toBe(false);
    expect(hasRuntimeHttpNoContentGuard(patched)).toBe(true);
    const streams = { Readable: { toWeb: () => new ReadableStream() } };
    const other = { Readable: { toWeb: () => new ReadableStream() } };
    const functions = new Function(
      "streams",
      "other",
      `${patched};return {proxied,request};`
    )(streams, other) as {
      proxied: (response: { statusCode: number; statusMessage?: string }, headers: Headers) => Response;
      request: (response: { statusCode: number; statusMessage?: string }, headers: Headers) => Response;
    };

    for (const status of [204, 205, 304]) {
      const response = functions.request({ statusCode: status }, new Headers());
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    }
    expect(functions.proxied({ statusCode: 200 }, new Headers()).body).not.toBeNull();
    expect(patchRuntimeHttpNoContent(patched)).toBe(patched);
    expect(patchRuntimeHttpNoContent("runtime without the HTTP wrapper")).toBe(
      "runtime without the HTTP wrapper"
    );
    expect(hasRuntimeHttpNoContentGuard("runtime without the HTTP wrapper")).toBe(false);
  });

  test("classifies wrapped transport failures without retrying in place after output", () => {
    const runtime = [
      "var yt2={ModelRequestFailed:'model_request_failed',ProviderNotConfigured:'provider_not_configured'},",
      "it2={Cancelled:'cancelled',NetworkError:'network_error',AuthFailed:'auth_failed',ServerError:'server_error',Unknown:'unknown'},",
      "nn2={NetworkError:'network_error',AuthRefresh:'auth_refresh',ServerError:'server_error'},",
      "SS=new Set(['provider_overloaded']);",
      "function jV(e){return!1}",
      "function pu2(e){return e}",
      "function s$(e){let t=e,r=new WeakSet;for(;t&&typeof t==='object'&&!r.has(t);){r.add(t);if(typeof t.statusCode==='number')return t.statusCode;t=t.cause}}",
      "function p_(e){return}",
      "function hdr2(e){return}",
      "function ddr2(e,t){return!1}",
      "function U_e2(e){return!1}",
      "function Ob2(e){return e&&typeof e==='object'?e:void 0}",
      "function d1o2(e){let t=e?.trim().toUpperCase();return t==='ECONNRESET'||t==='EPIPE'||t==='CONNECTIONCLOSED'}",
      "function fdr2(e){return!1}",
      "function Mye2(e){return e.retryable&&e.reason!==it2.Cancelled}",
      "function oO(e,t){return e===null||typeof e!==\"object\"?!1:t.has(e)?!0:(t.add(e),!1)}",
      "function pP(e){return e!==null&&typeof e===\"object\"?e:{}}",
      "function qQ(e,t){let r=e[t];return typeof r===\"string\"&&r.length>0?r:void 0}",
      "function w$(e){let t=e?.toUpperCase();return t===\"ECONNRESET\"||t===\"ECONNREFUSED\"||t===\"EAI_AGAIN\"||t===\"ENOTFOUND\"||t===\"ENETUNREACH\"||t===\"EHOSTUNREACH\"||t===\"UND_ERR_SOCKET\"||t===\"UND_ERR_CONNECT_TIMEOUT\"}",
      "function Rq(e){return kq(e,new WeakSet)}",
      "function kq(e,t){if(oO(e,t))return;let r=pP(e),n=qQ(r,\"code\");if(n)return n;let o=r.cause;if(o&&o!==e)return kq(o,t)}",
      "function qq(e,t){if(t){if(w$(t)||SS.has(t))return!0;let r=t.toLowerCase();if(r===\"network_error\"||r===\"network_error_retryable\")return!0}return jV(e)}",
      "function Wb(e,t){let r=pu2(e),n=s$(r),o=Rq(r),i=p_(r),a=hdr2(i);",
      "if(ddr2(r,t))return{code:yt2.ModelRequestFailed,message:'cancelled',reason:it2.Cancelled,retryReason:nn2.NetworkError,retryable:!1,statusCode:n};",
      "if(n===401||n===403)return{code:yt2.ProviderNotConfigured,message:'auth failed',reason:it2.AuthFailed,retryReason:nn2.AuthRefresh,retryable:!1,statusCode:n};",
      "if(w$(o))return{code:yt2.ModelRequestFailed,message:\"Network connection failed for the provider request.\",reason:it2.NetworkError,retryReason:nn2.NetworkError,retryable:!0,retryAfterMs:a,statusCode:n};",
      "let d=fdr2(r);return{code:yt2.ModelRequestFailed,message:'Model request failed.',reason:d?it2.ServerError:it2.Unknown,retryReason:d?nn2.ServerError:nn2.NetworkError,retryable:d,statusCode:n}}",
      "function s9o(e,t){let r=pu2(e);if(U_e2(r)||d1o2(Rq(r)))return!0;if(t!==void 0)return!1;let n=Ob2(r)?.providerCode;return d1o2(typeof n==\"number\"?String(n):n)}",
      "function z9o(e){return e.emittedRetryBoundaryEvent||e.attempt>=e.maxAttempts||e.failure.reason===it2.Cancelled?!1:e.preserveProviderStreamBoundaries===!0&&s9o(e.error,e.httpResponseStatus)?!0:Mye2(e.failure)?e.preserveProviderStreamBoundaries!==!0||e.streamFailurePhase!==\"response_body\":!1}",
      "function* walk(e){let t=e,r=new WeakSet;for(let n=0;n<=6;n+=1){if(!t||typeof t!=='object'||r.has(t))return;r.add(t);yield t;t=t.cause}}",
      "function recoverable(e){for(let t of walk(e)){if(t.retryable===!0)return!0;let r=pP(t.context);if(r.retryable===!0)return!0}return!1}"
    ].join("");
    const patched = patchRuntimeNetworkRetryClassification(runtime);

    expect(hasRuntimeNetworkRetryGuard(runtime)).toBe(false);
    expect(hasRuntimeNetworkRetryGuard(patched)).toBe(true);
    expect(patched).toContain("function $zTransportChain(e,t){");
    expect(patched).toContain("return e.emittedRetryBoundaryEvent||e.attempt>=e.maxAttempts");
    expect(patched).not.toContain("e.emittedRetryBoundaryEvent&&!$zTransportChain");
    expect(() => new Function(patched)).not.toThrow();
    expect(patchRuntimeNetworkRetryClassification(patched)).toBe(patched);
    expect(() => patchRuntimeNetworkRetryClassification("incompatible runtime")).toThrow(/incompatible/);

    const load = new Function(
      `${patched};return {classify:Wb,decide:qq,gate:z9o,recoverable,stale:s9o,transport:e=>$zTransportChain(e,new WeakSet)};`
    ) as () => {
      classify: (error: unknown) => {
        code: string;
        reason: string;
        retryable: boolean;
      };
      decide: (error: unknown, reason?: string) => boolean;
      gate: (failure: Record<string, unknown>) => boolean;
      recoverable: (error: unknown) => boolean;
      stale: (error: unknown, status?: number) => boolean;
      transport: (error: unknown) => boolean;
    };
    const { classify, decide, gate, recoverable, stale, transport } = load();

    const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const terminated = Object.assign(new TypeError("terminated"), { cause: socket });
    const wrapped = Object.assign(new Error("Model request failed"), {
      code: "model_request_failed",
      cause: terminated
    });
    const authorized = Object.assign(new Error("Model request failed"), {
      code: "model_request_failed",
      cause: Object.assign(new Error("Unauthorized"), { statusCode: 401, cause: socket })
    });

    expect(transport(wrapped)).toBe(true);
    expect(decide(wrapped)).toBe(true);
    expect(decide({}, "network_error")).toBe(true);
    expect(classify(wrapped)).toMatchObject({
      code: "model_request_failed",
      reason: "network_error",
      retryable: true
    });
    expect(transport(authorized)).toBe(true);
    expect(classify(authorized).retryable).toBe(false);
    expect(transport({ cause: { message: "write EPIPE" } })).toBe(true);
    expect(transport({ cause: { code: "ETIMEDOUT", message: "connect failed" } })).toBe(true);
    expect(stale(wrapped)).toBe(true);

    const failure = classify(wrapped);
    const beforeOutput = {
      emittedRetryBoundaryEvent: false,
      attempt: 1,
      maxAttempts: 6,
      failure,
      error: wrapped,
      preserveProviderStreamBoundaries: false
    };
    expect(gate(beforeOutput)).toBe(true);
    expect(gate({ ...beforeOutput, emittedRetryBoundaryEvent: true })).toBe(false);
    expect(gate({ ...beforeOutput, attempt: 6 })).toBe(false);
    expect(gate({ ...beforeOutput, failure: { ...failure, reason: "cancelled" } })).toBe(false);
    expect(recoverable({ cause: wrapped, context: { retryable: failure.retryable } })).toBe(true);

    const cyclic: { code?: string; cause?: unknown } = { code: "model_request_failed" };
    const cyclicCause: { code?: string; cause?: unknown } = {
      code: "model_request_failed",
      cause: cyclic
    };
    cyclic.cause = cyclicCause;
    expect(transport(cyclic)).toBe(false);
    expect(decide(cyclic)).toBe(false);
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

  test("updates the login model defaults to the current server catalog", () => {
    const runtime = [
      'function Cs(e){return typeof e==="object"&&e!==null&&!Array.isArray(e)}',
      'function Pni(e,t,r){let o=ICt[t],n=Cs(e.provider)?e.provider:{},',
      'i=Cs(n[t])?n[t]:{},a=Cs(i.options)?i.options:{},u=Cs(i.models)?i.models:{},',
      'l=Cs(u[kCt])?u[kCt]:{},c=Cs(u[SCt])?u[SCt]:{},d=Cs(e.model)?e.model:{},',
      'p=typeof d.lite=="string"?d.lite:o.liteModel,m={...a,apiKeyRequired:true,baseURL:o.baseURL};',
      'return r.length>0&&(m.apiKey=r),{...e,provider:{...n,[t]:{...i,kind:xni,name:o.displayName,options:m,',
      'models:{...u,[kCt]:{...l,name:"GLM-5.1"},[SCt]:{...c,name:"GLM-4.7"}}}},',
      'model:{...d,main:o.mainModel,lite:p}}}',
      'var fni="bigmodel",hni="zai",',
      'gni="zai/glm-5.1",_ni="zai/glm-4.7",vni="bigmodel/glm-5.1",yni="bigmodel/glm-4.7",',
      'kCt="glm-5.1",SCt="glm-4.7",xni="anthropic",',
      'ICt={[fni]:{baseURL:"https://open.bigmodel.cn/api/anthropic",displayName:"BigModel Coding Plan",',
      'liteModel:yni,mainModel:vni},[hni]:{baseURL:"https://api.z.ai/api/anthropic",',
      'displayName:"Z.AI Coding Plan",liteModel:_ni,mainModel:gni}};'
    ].join("");
    const patched = patchRuntimeLoginModelDefaults(runtime);
    const updateConfig = new Function(`${patched};return Pni;`)() as (
      config: Record<string, unknown>,
      providerId: string,
      apiKey: string
    ) => {
      model: { lite: string; main: string };
      provider: Record<string, { models: Record<string, unknown> }>;
    };

    expect(patched).toContain(
      'gni="zai/glm-5.2",_ni="zai/glm-5-turbo",vni="bigmodel/glm-5.2",yni="bigmodel/glm-4.7"'
    );
    expect(patched).toContain('kCt="glm-5.2",SCt="glm-4.7"');
    expect(patched).toContain('["glm-5-turbo"]:{...u["glm-5-turbo"],name:"GLM-5-Turbo"}');
    expect(patched).not.toContain('gni="zai/glm-5.1"');
    expect(patched).not.toContain('"GLM-5.1"');

    const zai = updateConfig({}, "zai", "zai-key");
    expect(zai.model).toEqual({ main: "zai/glm-5.2", lite: "zai/glm-5-turbo" });
    expect(Object.keys(zai.provider.zai!.models).sort()).toEqual([
      "glm-4.7",
      "glm-5-turbo",
      "glm-5.2"
    ]);

    const bigmodel = updateConfig({}, "bigmodel", "bigmodel-key");
    expect(bigmodel.model).toEqual({ main: "bigmodel/glm-5.2", lite: "bigmodel/glm-4.7" });
    expect(bigmodel.provider.bigmodel!.models["glm-4.7"]).toBeDefined();
    expect(updateConfig(
      { model: { lite: "zai/custom-lite" } },
      "bigmodel",
      "bigmodel-key"
    ).model.lite).toBe("bigmodel/glm-4.7");
    expect(updateConfig(
      { model: { lite: "bigmodel/custom-lite" } },
      "bigmodel",
      "bigmodel-key"
    ).model.lite).toBe("bigmodel/custom-lite");

    const partiallyUpdated = runtime.replace(
      'gni="zai/glm-5.1",_ni="zai/glm-4.7",vni="bigmodel/glm-5.1",yni="bigmodel/glm-4.7"',
      'gni="zai/glm-5.2",_ni="zai/glm-5-turbo",vni="bigmodel/glm-5.2",yni="bigmodel/glm-4.7"'
    );
    expect(patchRuntimeLoginModelDefaults(partiallyUpdated)).toBe(patched);
    expect(patchRuntimeLoginModelDefaults(patched)).toBe(patched);
    expect(() => patchRuntimeLoginModelDefaults("incompatible runtime")).toThrow(
      /login model defaults patch/
    );
  });

  test("applies required patches and records optional compatibility skips", () => {
    const result = applyRuntimePatchPlan("runtime", [
      {
        id: "optional-diagnostic",
        requirement: "optional",
        apply: () => {
          throw new Error("anchor moved");
        }
      },
      {
        id: "required-bridge",
        requirement: "required",
        apply: (runtime) => runtime.includes("|bridge") ? runtime : `${runtime}|bridge`,
        verify: (runtime) => runtime.endsWith("|bridge")
      }
    ]);

    expect(result.runtime).toBe("runtime|bridge");
    expect(result.reports).toEqual([
      {
        id: "optional-diagnostic",
        requirement: "optional",
        status: "skipped",
        message: "anchor moved"
      },
      { id: "required-bridge", requirement: "required", status: "applied" }
    ]);
    expect(() => applyRuntimePatchPlan("runtime", [{
      id: "required-bridge",
      requirement: "required",
      apply: () => {
        throw new Error("missing bridge anchor");
      }
    }])).toThrow(/Required runtime patch required-bridge failed/);
    expect(parseRuntimePatchReports(result.reports)).toEqual(result.reports);
    expect(parseRuntimePatchReports([{ ...result.reports[0], status: "unknown" }])).toBeUndefined();
  });

  test("formats and writes actionable compatibility reports for CI and issue updates", async () => {
    const report = {
      schemaVersion: 1,
      appVersion: "3.9.1",
      generatedAt: "2026-08-26T01:30:00.000Z",
      phase: "runtime_patch" as const,
      error: "Required runtime patch tui-bridge failed: anchor missing",
      runtimePatches: [{
        id: "tui-bridge",
        requirement: "required" as const,
        status: "failed" as const,
        message: "anchor | missing"
      }]
    } as const;
    const markdown = formatRuntimeCompatibilityFailure(report);
    expect(markdown).toContain("App version: `3.9.1`");
    expect(markdown).toContain("Required runtime patch tui-bridge failed");
    expect(markdown).toContain("anchor \\| missing");

    const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-report-"));
    try {
      const paths = await writeRuntimeCompatibilityFailure(report, directory);
      expect(await Bun.file(paths.jsonPath).json()).toEqual(report);
      expect(await Bun.file(paths.markdownPath).text()).toBe(markdown);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("maps supported static updater manifests", () => {
    expect(manifestUrl("linux", "x64")).toMatch(/update\/linux\/x64\/latest-linux\.yml$/);
    expect(manifestUrl("darwin", "arm64")).toMatch(/update\/mac\/arm64\/latest-mac\.yml$/);
    expect(manifestUrl("win32", "x64")).toMatch(/update\/win\/x64\/latest\.yml$/);
  });

  test("maps platforms to the Desktop stable update service", () => {
    expect(serviceReleasePlatform("linux", "x64")).toBe("linux-x86_64");
    expect(serviceReleasePlatform("darwin", "arm64")).toBe("darwin-aarch64");
    expect(serviceReleasePlatform("win32", "ia32")).toBe("windows-x86");
    expect(serviceManifestUrl("linux", "x64")).toBe(
      "https://zcode.z.ai/api/v1/releases/electron/manifest?platform=linux-x86_64&channel=1"
    );
  });

  test("resolves the latest runtime from the Desktop stable update service", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const sha512 = Buffer.alloc(64, 7).toString("base64");
    const result = await resolveLatestRuntimeLock(
      { platform: "linux", arch: "x64" },
      async (url, init) => {
        calls.push({ url, init });
        return JSON.stringify({
          version: "3.7.3",
          files: [{
            url: "/zcode/electron/releases/3.7.3/linux-x64/ZCode-3.7.3-linux-x64.deb",
            sha512
          }]
        });
      }
    );

    expect(result).toEqual({
      source: "service",
      url: serviceManifestUrl("linux", "x64"),
      lock: {
        schemaVersion: 1,
        appVersion: "3.7.3",
        platform: "linux",
        arch: "x64",
        url: "https://zcode.z.ai/zcode/electron/releases/3.7.3/linux-x64/ZCode-3.7.3-linux-x64.deb",
        sha512
      }
    });
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("Accept")).toContain("application/x-yaml");
    expect(headers.get("X-Platform")).toBe("linux-x86_64");
    expect(headers.get("X-Release-Channel")).toBe("1");
    expect(headers.get("X-Device-Mid")).toBeNull();
  });

  test("falls back to the static manifest when the service manifest is unusable", async () => {
    const calls: string[] = [];
    const sha512 = Buffer.alloc(64, 6).toString("base64");
    const result = await resolveLatestRuntimeLock(
      { platform: "linux", arch: "x64" },
      async (url) => {
        calls.push(url);
        if (calls.length === 1) {
          return JSON.stringify({
            version: "3.7.3",
            files: [{ url: "ZCode.AppImage", sha512 }]
          });
        }
        return JSON.stringify({
          version: "3.6.5",
          files: [{ url: "ZCode-3.6.5-linux-x64.deb", sha512 }]
        });
      }
    );

    const fallbackUrl = manifestUrl("linux", "x64");
    expect(calls).toEqual([serviceManifestUrl("linux", "x64"), fallbackUrl]);
    expect(result).toEqual({
      source: "static",
      url: fallbackUrl,
      lock: {
        schemaVersion: 1,
        appVersion: "3.6.5",
        platform: "linux",
        arch: "x64",
        url: "https://cdn-zcode.z.ai/zcode/electron/releases/update/linux/x64/ZCode-3.6.5-linux-x64.deb",
        sha512
      }
    });
  });

  test("resolves relative and absolute updater artifact URLs", () => {
    const manifest = manifestUrl("linux", "x64");
    const absolute = "https://cdn-zcode.z.ai/zcode/electron/releases/3.3.6/linux-x64/ZCode.deb";

    expect(resolveArtifactUrl(manifest, "ZCode.deb")).toBe(
      "https://cdn-zcode.z.ai/zcode/electron/releases/update/linux/x64/ZCode.deb"
    );
    expect(resolveArtifactUrl(manifest, absolute)).toBe(absolute);
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

  test("recognizes legacy and native multi-message file rewind support", () => {
    expect(supportsMultiMessageFileRewind("Array.isArray(e.targetMessageIds)")).toBe(true);
    expect(supportsMultiMessageFileRewind(
      "e.targetMessageIds&&e.targetMessageIds.length>0"
    )).toBe(true);
    expect(supportsMultiMessageFileRewind("e.targetMessageId?[e.targetMessageId]:[]")).toBe(false);
  });

  test("injects transcript and structured state readers into the official TUI adapter", async () => {
    const runtime = [
      "function R(e,t){return f(e,{rewindCreatedMessageId:t.revert?.createdMessageID,rewindKeptMessageIds:t.revert?.keptMessageIDs,rewindTargetMessageId:t.revert?.targetMessageID})}",
      "async function L(e){if(!e.sessionStore)return[];let t=await e.sessionStore.messages({sessionID:e.sessionId});return p(t)}",
      'function p(e){let t=[];for(let r of e){if(r.info.role==="user"){let l=r.text;t.push({content:l,role:"user"});continue}let n=[],s=[],u=r.text;t.push({content:u,...s.length>0?{parts:s}:{},role:"agent"})}return t}',
      "function c(e,t){if(t.targetMessageId)return O(e,[t.targetMessageId]);let r=P(e,t.targetCheckpointId);return r?[r]:[]}",
      "E.sendInput=async(A,$)=>{let c=t.runtime.getActiveTurnInfo();if(c)return t.runtime.steerTurn({commandKind:$?.commandKind,inputId:$?.inputId,queryId:$?.queryId,expectedTurnId:$?.expectedTurnId,input:A});return Kvt(await S(),D,O1(t))},",
      'listSkills:k(()=>H(e),"listSkills"),',
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
    expect(patched).toContain("E.loadSessionContextMessages=async()=>await(await S()).loadSessionContextMessages?.()??[]");
    expect(patched).toContain("E.listSkills=async()=>await H(e)");
    expect(patched).toContain("E.readGoal=async()=>await(await S()).readTarget?.()??null");
    expect(patched).toContain("E.readTodos=async()=>await(await S()).readTodos?.()??[]");
    expect(patched).toContain("E.readRuntimeProjection=async()=>{let $zRuntimeProjectionBridge=await S();await E.$zRestorePersistedBackgroundTasks?.($zRuntimeProjectionBridge);let t=await $zRuntimeProjectionBridge.runtime?.getProjection?.();if(!t)return null;");
    expect(patched).toContain(".filter(o=>o.isBackgrounded===!0).map(o=>");
    expect(patched).toContain("backgroundTaskDetails:r");
    expect(patched).toContain("E.$zRestorePersistedBackgroundTasks=async $zApp=>");
    expect(patched).toContain('$zApp.$zRestoredBackgroundTasksSession=$zApp.sessionId');
    expect(patched).toContain("$zApp.loadSessionTranscript?.()");
    expect(patched).toContain("error:typeof $zMetadata.error");
    expect(patched).toContain('$zToolName!=="agent"&&$zToolName!=="subagent"&&$zToolName!=="task"');
    expect(patched).toContain('childSessionId:"sess_subagent_"+$zAgentId');
    expect(patched).toContain('$zOutput.includes("Async agent launched successfully.")');
    expect(patched).toContain('.addAttachment?.("task_status"');
    expect(patched).toContain("E.$zSendInputWithoutBackgroundRestore=E.sendInput");
    expect(patched).toContain("s[$zIndex]={...s[$zIndex]");
    expect(patched).toContain("E.$zRestorePersistedBackgroundTasks?.(t)");
    expect(patched).toContain('$zSpawn.status!=="async_launched"&&$zSpawn.status!=="backgrounded"');
    expect(patched).toContain('status:$zStatus,taskType:"local_agent",type:"local_agent"');
    expect(patched).toContain('loadSessionContextMessages:a(async()=>await e.sessionStore.messages({sessionID:e.sessionId}),"loadSessionContextMessages")');
    expect(patched).not.toContain("$zRuntimeProjectionBridge.loadSessionContextMessages?.()");
    expect(patched).not.toContain("e.loadSessionTranscript?.()");
    expect(patched).toContain("E.readSessionUsage=async()=>await(await S()).readSessionUsage?.()??null");
    expect(patched).toContain("E.cancelBackgroundTask=async e=>await(await S()).cancelBackgroundTask?.(e)??null");
    expect(patched).toContain("E.subscribeSessionEvents=e=>{let t=!1,r;S().then(o=>{t||(r=o.runtime?.subscribeEvents?.({onSessionEvent:e}))});return()=>{t=!0,r?.()}}");
    expect(patched).toContain("E.sendBackgroundTaskMessage=async e=>");
    expect(patched).toContain('if(e?.restart===!0&&o.status==="running")');
    expect(patched).toContain("await r.subagentPort.stopTask(e.taskId)");
    expect(patched).toContain("r.subagentPort.sendMessage({sessionId:o.parentSessionId??r.getSessionId?.()");
    expect(patched).toContain("E.previewFileRewind=async e=>{let t=await S();return await t.runtime?.previewWorkspaceFileRewind?.({targetMessageIds:e})??null}");
    expect(patched).toContain("E.applyFileRewind=async e=>{let t=await S();return await t.runtime?.applyWorkspaceFileRewind?.({targetMessageIds:e})??null}");
    expect(patched).toContain("E.setMode=async e=>{let t=await S();if(t.setMode)return await t.setMode(e);t.runtime?.updateConfig?.({mode:e});return{mode:t.getMode?.()??e}}");
    expect(patched).toContain("E.interruptTurn=async e=>");
    expect(patched).toContain("t.runtime?.stopActiveForegroundExecution?.({preserveQueueAutoDrainOnCancel:");
    expect(patched).toContain('e?.waitForIdle===!0&&t.runtime?.getActiveForegroundExecutionId');
    expect(patched).toContain("t.runtime.getActiveForegroundExecutionId()!==void 0");
    expect(patched).toContain("await t.reserveQueueItem(a,r)");
    expect(patched).toContain(
      "expectedTurnId:$?.expectedTurnId,delivery:\"guide\",pendingInputId:$?.pendingInputId,input:A"
    );
    expect(patched).toContain("E.promoteQueuedInput=async(e,t,r)=>");
    expect(patched).toContain("r?.pendingInputReservationId??r?.queryId");
    expect(patched).toContain("i=(Array.isArray(t)?t:[t]).filter(Boolean)");
    expect(patched).toContain("o.reserveQueueItem(l,n)");
    expect(patched).toContain("if(await o.markQueueItemPromoting(l,n))");
    expect(patched).toContain("o.markQueueItemPromoting(l,n)");
    expect(patched).toContain('E.sendInput(e,{...r,delivery:"start_turn"})');
    expect(patched).toContain('o.removeQueueItem(l,{reason:"promoted",reservationId:n})');
    expect(patched).toContain("o.releaseQueueItemReservation(l,n)");
    expect(patched).toContain('messageId:r.info.id,role:"user"');
    expect(patched).toContain('messageId:r.info.id,role:"agent"');
    expect(patched).toContain("Array.isArray(t.targetMessageIds)");
    expect(patched).toContain("r=await e.sessionStore.getSession(e.sessionId);return p(r?R(t,r):t)");
    expect(patched).toContain("loadSessionTranscript:g.loadSessionTranscript");
    expect(patched).toContain("readGoal:g.readGoal");
    expect(patched).toContain("readTodos:g.readTodos");
    expect(patched).toContain("readRuntimeProjection:g.readRuntimeProjection");
    expect(patched).toContain("loadSessionContextMessages:g.loadSessionContextMessages");
    expect(patched).toContain("readSessionUsage:g.readSessionUsage");
    expect(patched).toContain("cancelBackgroundTask:g.cancelBackgroundTask");
    expect(patched).toContain("previewFileRewind:g.previewFileRewind");
    expect(patched).toContain("applyFileRewind:g.applyFileRewind");
    expect(patched).toContain("interruptTurn:g.interruptTurn");
    expect(patched).toContain("promoteQueuedInput:g.promoteQueuedInput");
    expect(patched).toContain("listSkills:g.listSkills");
    expect(patched).toContain("setMode:g.setMode");
    expect(patched).toContain("subscribeSessionEvents:g.subscribeSessionEvents");
    expect(patched).toContain("sendBackgroundTaskMessage:g.sendBackgroundTaskMessage");
    expect(patched).toContain("sessionStore.queryTaskUsage?.({sessionID:e.sessionId})");
    const projectionStart = patched.indexOf("E.readRuntimeProjection=async()=>");
    const projectionEnd = patched.indexOf(",E.readSessionUsage=", projectionStart);
    const projectionAssignment = patched.slice(projectionStart, projectionEnd);
    const bridge: { readRuntimeProjection?: () => Promise<Record<string, unknown>> } = {};
    const readRuntimeProjection = new Function(
      "E",
      "S",
      `${projectionAssignment};return E.readRuntimeProjection;`
    )(
      bridge,
      async () => ({
        runtime: {
          getProjection: () => ({
            activeToolCalls: [],
            backgroundTasks: [],
            contextUsed: 1_000,
            contextWindow: 100_000
          }),
          runtimeTaskRegistry: { all: () => ({}) }
        }
      })
    ) as () => Promise<Record<string, unknown>>;
    expect(await readRuntimeProjection()).toMatchObject({
      contextUsed: 1_000,
      contextWindow: 100_000,
      backgroundTaskDetails: []
    });

    const liveProjectionBridge: { readRuntimeProjection?: () => Promise<Record<string, unknown>> } = {};
    const liveReadRuntimeProjection = new Function(
      "E",
      "S",
      `${projectionAssignment};return E.readRuntimeProjection;`
    )(
      liveProjectionBridge,
      async () => ({
        runtime: {
          getProjection: () => ({
            activeToolCalls: [],
            backgroundTasks: [{
              taskId: "agent-live",
              taskKind: "local_agent",
              status: "failed",
              error: "Provider authentication failed.",
              completedAt: Date.now() - 1_000,
              blocked: true,
              blockedReason: "previous failure"
            }]
          }),
          runtimeTaskRegistry: {
            all: () => ({
              "agent-live": {
                taskId: "agent-live",
                taskType: "local_agent",
                type: "local_agent",
                agentId: "agent-live",
                agentType: "Explore",
                childSessionId: "sess-child-live",
                parentSessionId: "sess-parent-live",
                status: "running",
                isBackgrounded: true
              }
            })
          }
        }
      })
    ) as () => Promise<Record<string, unknown>>;
    const liveProjection = await liveReadRuntimeProjection();
    expect(liveProjection.backgroundTasks).toEqual([expect.objectContaining({
      taskId: "agent-live",
      status: "running",
      error: null,
      completedAt: null,
      blocked: null,
      blockedReason: null,
      cancellable: true
    })]);

    const restoreStart = patched.indexOf("E.$zRestorePersistedBackgroundTasks=async $zApp=>");
    const restoreEnd = patched.indexOf(",E.recallPreviousInput=", restoreStart);
    expect(restoreStart).toBeGreaterThan(0);
    expect(restoreEnd).toBeGreaterThan(restoreStart);
    const restoreBackgroundTasks = new Function(
      "E",
      `${patched.slice(restoreStart, restoreEnd)};return E.$zRestorePersistedBackgroundTasks;`
    )({}) as (app: unknown) => Promise<void>;
    {
      const spawnOutput = (status: string) => JSON.stringify({
        status,
        isAsync: true,
        agentId: "agent_9",
        agentType: "Explore",
        description: "Investigate renderer",
        prompt: "Look into it",
        childSessionId: "sess_child_9",
        backgroundTaskId: "agent_9",
        outputFile: join(outputDirectory, "output.txt")
      });
      const outputDirectory = await mkdtemp(join(tmpdir(), "zcode-restore-"));
      try {
        const spawnPart = (status: string) => ({
          type: "tool",
          toolName: "Agent",
          toolCallId: "call_1",
          output: spawnOutput(status)
        });
        const registered: Record<string, unknown>[] = [];
        const store = new Map<string, Record<string, unknown>>();
        const registry = {
          register: (task: Record<string, unknown>) => {
            registered.push(task);
            store.set(String(task.taskId), task);
          },
          get: (taskId: string) => store.get(taskId)
        };
        const reminders: Array<{ source: string; text: string }> = [];
        let rawContextLoads = 0;
        const appFor = (parts: unknown[]) => ({
          sessionId: "sess_parent",
          $zRestoredBackgroundTasksLog: [] as Array<Record<string, unknown>>,
          runtime: {
            runtimeTaskRegistry: registry,
            messageHistory: {
              addAttachment: (source: string, text: string) => reminders.push({ source, text })
            }
          },
          loadSessionTranscript: async () => [{ messageId: "m1", role: "agent", parts }],
          loadSessionContextMessages: async () => {
            rawContextLoads += 1;
            return [{ info: { id: "inactive-branch", role: "assistant" }, parts: [spawnPart("async_launched")] }];
          }
        });
        const firstRestoreApp = appFor([spawnPart("async_launched")]);
        await restoreBackgroundTasks(firstRestoreApp);
        expect(rawContextLoads).toBe(0);
        expect(registered).toHaveLength(1);
        expect(firstRestoreApp.$zRestoredBackgroundTasksLog).toHaveLength(1);
        expect(firstRestoreApp.$zRestoredBackgroundTasksLog[0]).toMatchObject({ taskId: "agent_9", status: "stopped" });
        expect(registered[0]).toMatchObject({
          taskId: "agent_9",
          agentId: "agent_9",
          agentType: "Explore",
          childSessionId: "sess_child_9",
          parentSessionId: "sess_parent",
          parentToolCallId: "call_1",
          status: "stopped",
          taskType: "local_agent",
          type: "local_agent",
          isBackgrounded: true
        });
        expect(reminders).toHaveLength(1);
        expect(reminders[0]).toMatchObject({ source: "task_status" });
        expect(reminders[0]?.text).toContain("Earlier TaskOutput errors");
        expect(reminders[0]?.text).toContain("agent_9 (stopped)");
        await restoreBackgroundTasks(appFor([spawnPart("async_launched")]));
        expect(registered).toHaveLength(1);
        expect(reminders).toHaveLength(1);

        await writeFile(join(outputDirectory, "metadata.json"), `${JSON.stringify({
          agentId: "agent_9",
          status: "completed",
          error: "stale error from the first attempt"
        })}\n`);
        const registryForCompleted: Record<string, unknown>[] = [];
        await restoreBackgroundTasks({
          sessionId: "sess_parent_2",
          runtime: {
            runtimeTaskRegistry: {
              register: (task: Record<string, unknown>) => registryForCompleted.push(task),
              get: () => undefined
            }
          },
          loadSessionTranscript: async () => [{ messageId: "m2", role: "agent", parts: [spawnPart("async_launched")] }]
        });
        expect(registryForCompleted).toHaveLength(1);
        expect(registryForCompleted[0]).toMatchObject({
          status: "completed",
          error: "stale error from the first attempt"
        });

        await restoreBackgroundTasks({
          sessionId: "sess_parent_3",
          runtime: {
            runtimeTaskRegistry: {
              register: (task: Record<string, unknown>) => registered.push(task),
              get: (taskId: string) => store.get(taskId)
            }
          },
          loadSessionTranscript: async () => [{ messageId: "m3", role: "agent", parts: [spawnPart("backgrounded")] }]
        });
        expect(registered).toHaveLength(1);

        await restoreBackgroundTasks({
          sessionId: "sess_parent_4",
          runtime: {
            runtimeTaskRegistry: {
              register: (task: Record<string, unknown>) => registered.push(task),
              get: () => undefined
            }
          },
          loadSessionTranscript: async () => [{
            messageId: "m4",
            role: "agent",
            parts: [{
              type: "tool",
              toolName: "Agent",
              toolCallId: "call_2",
              output: JSON.stringify({ status: "completed", agentId: "agent_10", content: "done" })
            }]
          }]
        });
        expect(registered).toHaveLength(1);

        const taskAliasRegistered: Record<string, unknown>[] = [];
        await restoreBackgroundTasks({
          sessionId: "sess_parent_task_alias",
          runtime: {
            runtimeTaskRegistry: {
              register: (task: Record<string, unknown>) => taskAliasRegistered.push(task),
              get: () => undefined
            }
          },
          loadSessionTranscript: async () => [{
            messageId: "m-task",
            role: "agent",
            parts: [{
              type: "tool",
              toolName: "Task",
              toolCallId: "call_task",
              output: JSON.stringify({
                status: "async_launched",
                agentId: "agent_task",
                agentType: "Explore",
                childSessionId: "sess_child_task"
              })
            }]
          }]
        });
        expect(taskAliasRegistered).toHaveLength(1);
        expect(taskAliasRegistered[0]).toMatchObject({
          taskId: "agent_task",
          parentToolCallId: "call_task",
          status: "stopped"
        });

        const modelTextAgentId = "agent_model_text";
        const modelTextOutputFile = join(outputDirectory, "model-output.txt");
        await writeFile(join(outputDirectory, "metadata.json"), `${JSON.stringify({
          agentId: modelTextAgentId,
          childSessionId: "sess_subagent_agent_model_text",
          description: "Persisted model-text agent",
          outputFile: modelTextOutputFile,
          parentSessionId: "sess_parent_model_text",
          parentToolUseId: "call_model_text",
          profileId: "Explore",
          prompt: "Continue the persisted task",
          status: "running"
        })}\n`);
        const modelTextRegistered: Record<string, unknown>[] = [];
        await restoreBackgroundTasks({
          sessionId: "sess_parent_model_text",
          runtime: {
            runtimeTaskRegistry: {
              register: (task: Record<string, unknown>) => modelTextRegistered.push(task),
              get: () => undefined
            }
          },
          loadSessionTranscript: async () => [{
            messageId: "m-model-text",
            role: "agent",
            parts: [{
              type: "tool",
              toolName: "Agent",
              toolCallId: "call_model_text",
              input: {
                description: "Persisted model-text agent",
                prompt: "Continue the persisted task",
                subagent_type: "Explore"
              },
              output: [
                "Async agent launched successfully.",
                `agentId: ${modelTextAgentId} (internal ID - use SendMessage to continue)`,
                "The agent is working in the background.",
                `output_file: ${modelTextOutputFile}`
              ].join("\n")
            }]
          }]
        });
        expect(modelTextRegistered).toHaveLength(1);
        expect(modelTextRegistered[0]).toMatchObject({
          taskId: modelTextAgentId,
          agentId: modelTextAgentId,
          agentType: "Explore",
          childSessionId: "sess_subagent_agent_model_text",
          outputFile: modelTextOutputFile,
          parentSessionId: "sess_parent_model_text",
          parentToolCallId: "call_model_text",
          status: "stopped"
        });

        const foregroundRegistered: Record<string, unknown>[] = [];
        await restoreBackgroundTasks({
          sessionId: "sess_parent_foreground",
          runtime: {
            runtimeTaskRegistry: {
              register: (task: Record<string, unknown>) => foregroundRegistered.push(task),
              get: () => undefined
            }
          },
          loadSessionTranscript: async () => [{
            messageId: "m-foreground",
            role: "agent",
            parts: [{
              type: "tool",
              toolName: "Agent",
              toolCallId: "call_foreground",
              input: {
                description: "Foreground review",
                prompt: "Review the renderer",
                subagent_type: "Explore"
              },
              output: [
                "Foreground review complete.",
                "agentId: agent_foreground (use SendMessage with to: 'agent_foreground' to continue this agent)",
                "<usage>tool_uses: 2</usage>"
              ].join("\n")
            }]
          }]
        });
        expect(foregroundRegistered).toHaveLength(0);
      } finally {
        await rm(outputDirectory, { recursive: true, force: true });
      }

      // A transient restore failure must not pin the session sentinel; the
      // next projection poll has to retry the scan.
      const retryRegistered: Record<string, unknown>[] = [];
      let retryCalls = 0;
      const retryApp = {
        sessionId: "sess_parent_5",
        runtime: {
          runtimeTaskRegistry: {
            register: (task: Record<string, unknown>) => retryRegistered.push(task),
            get: () => undefined
          }
        },
        loadSessionTranscript: async () => {
          retryCalls += 1;
          if (retryCalls === 1) throw new Error("database is locked");
          return [{
            info: { id: "m5", role: "assistant" },
            parts: [{
              type: "tool",
              toolName: "Agent",
              toolCallId: "call_3",
              output: JSON.stringify({
                status: "async_launched",
                agentId: "agent_11",
                agentType: "Explore",
                childSessionId: "sess_child_11"
              })
            }]
          }];
        }
      };
      await restoreBackgroundTasks(retryApp);
      expect(retryRegistered).toHaveLength(0);
      await restoreBackgroundTasks(retryApp);
      expect(retryRegistered).toHaveLength(1);
    }

    const restoreBeforeSendStart = patched.indexOf("E.$zSendInputWithoutBackgroundRestore=E.sendInput");
    const restoreBeforeSendEnd = patched.indexOf(",E.recallPreviousInput=", restoreBeforeSendStart);
    expect(restoreBeforeSendStart).toBeGreaterThan(0);
    expect(restoreBeforeSendEnd).toBeGreaterThan(restoreBeforeSendStart);
    const sendOrder: string[] = [];
    const sendBridge = {
      sendInput: async (input: string) => {
        sendOrder.push(`send:${input}`);
        return { kind: "started_turn" };
      },
      $zRestorePersistedBackgroundTasks: async (app: unknown) => {
        expect(app).toEqual({ id: "app" });
        sendOrder.push("restore");
      }
    };
    const wrappedSendInput = new Function(
      "E",
      "S",
      `${patched.slice(restoreBeforeSendStart, restoreBeforeSendEnd)};return E.sendInput;`
    )(sendBridge, async () => ({ id: "app" })) as (input: string) => Promise<unknown>;
    await wrappedSendInput("continue");
    expect(sendOrder).toEqual(["restore", "send:continue"]);

    const taskMessageStart = patched.indexOf("E.sendBackgroundTaskMessage=async e=>");
    const taskMessageEnd = patched.indexOf(",E.interruptTurn=", taskMessageStart);
    expect(taskMessageStart).toBeGreaterThan(0);
    expect(taskMessageEnd).toBeGreaterThan(taskMessageStart);
    const taskMessageBridge: {
      $zRestorePersistedBackgroundTasks?: (app: unknown) => Promise<void>;
      sendBackgroundTaskMessage?: (options: Record<string, unknown>) => Promise<unknown>;
    } = {};
    const taskMessageRegistry = new Map<string, Record<string, unknown>>();
    const taskMessagePayloads: Record<string, unknown>[] = [];
    const taskMessageApp = {
      sessionId: "sess_parent_message",
      runtime: {
        runtimeTaskRegistry: {
          register: (task: Record<string, unknown>) => taskMessageRegistry.set(String(task.taskId), task),
          get: (taskId: string) => taskMessageRegistry.get(taskId)
        },
        subagentPort: {
          sendMessage: async (payload: Record<string, unknown>) => {
            taskMessagePayloads.push(payload);
            return { status: "success", delivery: "resumed_background", message: "resumed" };
          }
        }
      },
      loadSessionTranscript: async () => [{
        messageId: "message-agent",
        role: "assistant",
        parts: [{
          type: "tool",
          toolName: "Agent",
          toolCallId: "call-agent",
          output: JSON.stringify({
            status: "async_launched",
            agentId: "agent-message",
            agentType: "Explore",
            childSessionId: "sess-child-message"
          })
        }]
      }]
    };
    taskMessageBridge.$zRestorePersistedBackgroundTasks = async (app: unknown) => {
      const runtime = (app as typeof taskMessageApp).runtime;
      runtime.runtimeTaskRegistry.register({
        taskId: "agent-message",
        agentId: "agent-message",
        agentType: "Explore",
        childSessionId: "sess-child-message",
        parentSessionId: "sess_parent_message",
        parentToolCallId: "call-agent",
        status: "failed",
        taskType: "local_agent",
        type: "local_agent",
        isBackgrounded: true
      });
    };
    const taskMessage = new Function(
      "E",
      "S",
      `${patched.slice(taskMessageStart, taskMessageEnd)};return E.sendBackgroundTaskMessage;`
    )(
      taskMessageBridge,
      async () => taskMessageApp
    ) as (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const taskMessageResult = await taskMessage({
      taskId: "agent-message",
      message: "Continue with the saved instructions",
      summary: "Continue with the saved instructions"
    });
    expect(taskMessageResult).toMatchObject({ status: "success", delivery: "resumed_background" });
    expect(taskMessagePayloads).toHaveLength(1);
    expect(taskMessagePayloads[0]).toMatchObject({
      sessionId: "sess_parent_message",
      parentToolCallId: "call-agent",
      to: "agent-message",
      message: "Continue with the saved instructions"
    });

    expect(patchRuntimeTuiBridge(patched)).toBe(patched);
    const unsafeBackgroundRestorePatch = patched.replace(
      'if(!$zOutput.includes("Async agent launched successfully."))continue;',
      ""
    );
    expect(patchRuntimeTuiBridge(unsafeBackgroundRestorePatch)).toContain(
      '$zOutput.includes("Async agent launched successfully.")'
    );
    const previousInterruptPatch = patched.replace("e?.waitForIdle===!0", "e?.waitForIdle===!1");
    expect(patchRuntimeTuiBridge(previousInterruptPatch)).toContain("e?.waitForIdle===!0");
    expect(() => patchRuntimeTuiBridge("incompatible runtime")).toThrow(/incompatible/);

    const modernRuntime = runtimeWithApp
      .replace(
        "function R(e,t){return f(e,{rewindCreatedMessageId:t.revert?.createdMessageID,rewindKeptMessageIds:t.revert?.keptMessageIDs,rewindTargetMessageId:t.revert?.targetMessageID})}",
        "function R(e,t){return f(e,{branchCutAfterMessageId:t.revert?.branchCutAfterMessageID,rewindCreatedMessageId:t.revert?.createdMessageID,rewindKeptMessageIds:t.revert?.keptMessageIDs,rewindTargetMessageId:t.revert?.targetMessageID})}"
      )
      .replace(
        "function c(e,t){if(t.targetMessageId)return O(e,[t.targetMessageId]);let r=P(e,t.targetCheckpointId);return r?[r]:[]}",
        "function c(e,t){let r=t.targetMessageIds&&t.targetMessageIds.length>0?t.targetMessageIds:t.targetMessageId?[t.targetMessageId]:[];return O(e,r)}"
      );
    const modernPatched = patchRuntimeTuiBridge(modernRuntime);
    expect(modernPatched).toContain("r=await e.sessionStore.getSession(e.sessionId);return p(r?R(t,r):t)");
    expect(modernPatched).toContain("targetMessageIds&&t.targetMessageIds.length>0");
    expect(modernPatched).not.toContain("Array.isArray(t.targetMessageIds)");

    const nativeSteerRuntime = `${runtimeWithApp.replace(
      "E.sendInput=async(A,$)=>{let c=t.runtime.getActiveTurnInfo();if(c)return t.runtime.steerTurn({commandKind:$?.commandKind,inputId:$?.inputId,queryId:$?.queryId,expectedTurnId:$?.expectedTurnId,input:A});return Kvt(await S(),D,O1(t))},",
      "E.sendInput=async(A,$)=>{let d=$?.delivery??\"auto\";return t.runtime.admitPrompt(A,[],{...$,delivery:d,traceContext:$?.traceContext})},"
      + "function admit(A,$){if($?.delivery===\"steer_active_turn\")return this.steerTurn({commandKind:$?.commandKind,delivery:void 0,expectedTurnId:$?.expectedTurnId,input:A,inputId:$?.inputId,intent:I($?.intent,\"queue\"),queryId:$?.queryId,toolDisallowlist:$?.toolDisallowlist})}"
    )}async function send(H,Z){let Q=await A(),X=await Q.sendInput(H,Z);return X.kind!==\"started_turn\"?X:l1t(X.result,Q,R5(t))}`;
    const nativeSteerPatched = patchRuntimeTuiBridge(nativeSteerRuntime);
    expect(nativeSteerPatched).toContain('delivery==="steer_active_turn"');
    expect(nativeSteerPatched).toContain('intent:I($?.intent,"queue")');
    expect(nativeSteerPatched).not.toContain('pendingInputId:$?.pendingInputId');
    expect(nativeSteerPatched).toContain('l1t(await(X.result??X.completion),Q,R5(t))');
    expect(nativeSteerPatched).not.toContain('l1t(X.result,Q,R5(t))');
    expect(patchRuntimeTuiBridge(nativeSteerPatched)).toBe(nativeSteerPatched);
    expect(() => patchRuntimeTuiBridge(
      nativeSteerRuntime.replace(
        "return t.runtime.admitPrompt(A,[],{...$,delivery:d,traceContext:$?.traceContext})",
        "return t.runtime.submitPrompt(A,$)"
      )
    )).toThrow(/active-turn steer delivery anchor missing/);
  });

  test("upgrades an already-patched runtime that lacks the transient model bridge", () => {
    // Simulate a runtime patched by an older patchRuntimeTuiBridge: the
    // fixture above fully patched (minus setTransientModel, which did not
    // exist yet). The patch must detect the gap and add the bridge + option
    // instead of short-circuiting as "already patched".
    const runtime = [
      "function R(e,t){return f(e,{rewindCreatedMessageId:t.revert?.createdMessageID,rewindKeptMessageIds:t.revert?.keptMessageIDs,rewindTargetMessageId:t.revert?.targetMessageID})}",
      "async function L(e){if(!e.sessionStore)return[];let t=await e.sessionStore.messages({sessionID:e.sessionId});return p(t)}",
      'function p(e){let t=[];for(let r of e){if(r.info.role==="user"){let l=r.text;t.push({content:l,role:"user"});continue}let n=[],s=[],u=r.text;t.push({content:u,...s.length>0?{parts:s}:{},role:"agent"})}return t}',
      "function c(e,t){if(t.targetMessageId)return O(e,[t.targetMessageId]);let r=P(e,t.targetCheckpointId);return r?[r]:[]}",
      "E.sendInput=async(A,$)=>{let c=t.runtime.getActiveTurnInfo();if(c)return t.runtime.steerTurn({commandKind:$?.commandKind,inputId:$?.inputId,queryId:$?.queryId,expectedTurnId:$?.expectedTurnId,input:A});return Kvt(await S(),D,O1(t))},",
      'listSkills:k(()=>H(e),"listSkills"),',
      "E.recallPreviousInput=async A=>await(await S()).recallPreviousInputHistory?.(A)??null,",
      "CVr(E,S,r);",
      "return c({recallPreviousInput:g.recallPreviousInput,sendInput:g.sendInput,submitPrompt:g})"
    ].join("").replace(
      "E.sendInput",
      'loadSessionTranscript:a(async()=>await dUr({sessionId:e.sessionId,sessionStore:e.sessionStore}),"loadSessionTranscript"),readTodos:E.sendInput'
    );
    // Fully apply the current patch, then strip only the transient-model
    // injections to model an older patch generation.
    const fullyPatched = patchRuntimeTuiBridge(runtime);
    const stripped = fullyPatched
      .replace(/[A-Za-z_$]+\.setTransientModel=async e=>await\(await [A-Za-z_$]+\(\)\)\.setModel\?\.\(e,\{transient:!0\}\),/u, "")
      .replace(/setTransientModel:[A-Za-z_$][\w$]*\.setTransientModel,/u, "");
    expect(stripped).not.toMatch(/\.setTransientModel=async/u);
    expect(stripped).not.toMatch(/setTransientModel:[A-Za-z_$][\w$]*\.setTransientModel/u);

    const patched = patchRuntimeTuiBridge(stripped);
    expect(patched).toMatch(/\.setTransientModel=async/u);
    expect(patched).toMatch(/setTransientModel:[A-Za-z_$][\w$]*\.setTransientModel/u);
    expect(patchRuntimeTuiBridge(patched)).toBe(patched);
  });

  test("upgrades an already-patched runtime that lacks the mode bridge", () => {
    const runtime = [
      "function R(e,t){return f(e,{rewindCreatedMessageId:t.revert?.createdMessageID,rewindKeptMessageIds:t.revert?.keptMessageIDs,rewindTargetMessageId:t.revert?.targetMessageID})}",
      "async function L(e){if(!e.sessionStore)return[];let t=await e.sessionStore.messages({sessionID:e.sessionId});return p(t)}",
      'function p(e){let t=[];for(let r of e){if(r.info.role==="user"){let l=r.text;t.push({content:l,role:"user"});continue}let n=[],s=[],u=r.text;t.push({content:u,...s.length>0?{parts:s}:{},role:"agent"})}return t}',
      "function c(e,t){if(t.targetMessageId)return O(e,[t.targetMessageId]);let r=P(e,t.targetCheckpointId);return r?[r]:[]}",
      "E.sendInput=async(A,$)=>{let c=t.runtime.getActiveTurnInfo();if(c)return t.runtime.steerTurn({commandKind:$?.commandKind,inputId:$?.inputId,queryId:$?.queryId,expectedTurnId:$?.expectedTurnId,input:A});return Kvt(await S(),D,O1(t))},",
      'listSkills:k(()=>H(e),"listSkills"),',
      "E.recallPreviousInput=async A=>await(await S()).recallPreviousInputHistory?.(A)??null,",
      "CVr(E,S,r);",
      "return c({recallPreviousInput:g.recallPreviousInput,sendInput:g.sendInput,submitPrompt:g})"
    ].join("").replace(
      "E.sendInput",
      'loadSessionTranscript:a(async()=>await dUr({sessionId:e.sessionId,sessionStore:e.sessionStore}),"loadSessionTranscript"),readTodos:E.sendInput'
    );
    const fullyPatched = patchRuntimeTuiBridge(runtime);
    const stripped = fullyPatched
      .replace(/[A-Za-z_$]+\.setMode=async e=>\{let t=await [A-Za-z_$][\w$]*\(\);if\(t\.setMode\)return await t\.setMode\(e\);t\.runtime\?\.updateConfig\?\.\(\{mode:e\}\);return\{mode:t\.getMode\?\.\(\)\?\?e\}\},/u, "")
      .replace(/setMode:[A-Za-z_$][\w$]*\.setMode,/u, "");
    expect(stripped).not.toMatch(/\.setMode=async/u);
    expect(stripped).not.toMatch(/setMode:[A-Za-z_$][\w$]*\.setMode/u);

    const patched = patchRuntimeTuiBridge(stripped);
    expect(patched).toMatch(/\.setMode=async/u);
    expect(patched).toMatch(/setMode:[A-Za-z_$][\w$]*\.setMode/u);
    expect(patchRuntimeTuiBridge(patched)).toBe(patched);
  });

  test("auto-backgrounds long Agent calls while preserving explicit configuration", () => {
    const runtime = "function delay(){return{autoBackgroundMs:this.config.subagents?.autoBackgroundMs,outputRootDir:'tasks'}}";
    const patched = patchRuntimeAgentAutoBackground(runtime);
    const delay = new Function(`${patched};return delay;`)() as () => { autoBackgroundMs?: number };

    expect(delay.call({ config: {} }).autoBackgroundMs).toBe(1_000);
    expect(delay.call({ config: { subagents: { autoBackgroundMs: 0 } } }).autoBackgroundMs).toBe(0);
    expect(patchRuntimeAgentAutoBackground(patched)).toBe(patched);
    expect(() => patchRuntimeAgentAutoBackground("incompatible runtime")).toThrow(/incompatible/);
  });

  test("contains failures from the detached background Agent lifecycle", async () => {
    const runtime = [
      "async function run(){throw void 0}",
      "async function start(){",
      "let d={promise:Promise.resolve(),reject(){}},h={dispose(){}};",
      "run({onSessionStartFailed:d.reject},h.dispose);try{await d.promise}catch{}",
      "let q={promise:Promise.resolve(),reject(){}},x={dispose(){}};",
      "run({onSessionStartFailed:q.reject},x.dispose);try{await q.promise}catch{}",
      "await Promise.resolve();await Promise.resolve()",
      "}"
    ].join("");
    const patched = patchRuntimeDetachedAgentLifecycle(runtime);
    const diagnostics: unknown[][] = [];
    const start = new Function(
      "console",
      `${patched};return start;`
    )({ error: (...values: unknown[]) => diagnostics.push(values) }) as () => Promise<void>;

    await start();
    expect(diagnostics).toEqual([
      ["Detached background agent lifecycle failed", "unknown rejection"],
      ["Detached background agent lifecycle failed", "unknown rejection"]
    ]);
    expect(patchRuntimeDetachedAgentLifecycle(patched)).toBe(patched);
    expect(() => patchRuntimeDetachedAgentLifecycle("incompatible runtime")).toThrow(/incompatible/);
  });

  test("clears stale active tools when a runtime turn settles", () => {
    const runtime = [
      'function complete(e){return{...e,status:"idle",totalTokenCount:e.totalTokenCount+1}}',
      'function fail(e){return{...e,status:"error",lastError:{message:"failed"}}}'
    ].join("");
    const patched = patchRuntimeTerminalToolProjection(runtime);
    const load = new Function(`${patched};return {complete,fail};`)() as {
      complete: (state: Record<string, unknown>) => Record<string, unknown>;
      fail: (state: Record<string, unknown>) => Record<string, unknown>;
    };
    const state = {
      activeToolCalls: [{ toolCallId: "stale", status: "running" }],
      currentTurnId: "turn-1",
      totalTokenCount: 0
    };

    expect(load.complete(state)).toMatchObject({
      activeToolCalls: [],
      currentTurnId: undefined,
      status: "idle"
    });
    expect(load.fail(state)).toMatchObject({
      activeToolCalls: [],
      currentTurnId: undefined,
      status: "error"
    });
    expect(patchRuntimeTerminalToolProjection(patched)).toBe(patched);
    expect(() => patchRuntimeTerminalToolProjection("incompatible runtime")).toThrow(/incompatible/);
  });

  test("pauses active goals when a continuation turn fails", async () => {
    const runtime = [
      "async function execute(e){",
      "await this.finishTargetTurnAccounting({endedAtMs:Date.now(),inputID:i,startedTarget:t,status:e.type===CoreErrorType.TurnCancelled?\"paused\":void 0,traceContext:c});",
      "}"
    ].join("");
    const patched = patchRuntimeGoalFailurePause(runtime);
    const statuses: unknown[] = [];
    const execute = new Function(
      "CoreErrorType",
      "i",
      "t",
      "c",
      `${patched};return execute;`
    )({ TurnCancelled: "cancelled" }, "input", {}, {}) as (
      this: { finishTargetTurnAccounting: (input: { status?: string }) => Promise<void> },
      error: { type: string }
    ) => Promise<void>;

    await execute.call({
      finishTargetTurnAccounting: async (input) => {
        statuses.push(input.status);
      }
    }, { type: "model_request_failed" });

    expect(patched).toContain('startedTarget:t,status:"paused",traceContext:c');
    expect(statuses).toEqual(["paused"]);
    expect(patchRuntimeGoalFailurePause(patched)).toBe(patched);
    expect(() => patchRuntimeGoalFailurePause("incompatible runtime")).toThrow(/incompatible/);
  });

  test("reclassifies a graceful mid-stream EOF without a finish reason as retryable", () => {
    const runtime = [
      "function detectFallback(e){return}",
      "function findProviderError(e){return}",
      "function isSuspicious(e){return!1}",
      "function logStream(e){return}",
      "function publishFailure(e){return}",
      "function classifyFailure(e){return}",
      "class TerminalStreamError extends Error{}",
      "async function*got_no_content;"
    ].join("");
    const runner = [
      "async function*streamRunner(e){let retryState=createRetryState({maxAttempts:e.retry.maxAttempts});",
      // the runStreamText completion branch: suspicious-empty retry -> success tail
      "if(isSuspicious(x)){let le=findProviderError({providerId:String(k.model.providerId),providerKind:k.providerKind,source:x.lastErrorChunk??x.lastFinishChunk});",
      "if(le){throw new TerminalStreamError(String(le))}",
      "if(e.request.preserveProviderStreamBoundaries!==!0&&XX({finishReason:x.finishReason,reasoningLength:x.reasoningDeltaChars,textLength:x.textDeltaChars,toolCallCount:x.toolCallCount,usage:x.usage})&&tee({abortSignal:e.request.abortSignal,attempt:u,maxAttempts:e.retry.maxAttempts,retryCount:s})){let fe=await fhr(W),ue=Date.now();logStream({attempt:u,diagnostics:x,durationMs:ue-c,emittedError:h,emittedEvent:p,logger:e.logger,outboundHeaders:H.headers,statusContext:k}),s+=1,await g2e({abortSignal:e.request.abortSignal,attempt:u,completedAt:ue,errorPhase:\"stream\",logger:e.logger,requestHeaders:F,requestStatusSink:e.request.statusSink,responseHeaders:fe,retry:e.retry,retryBudgetAttempt:l,startedAt:c,statusContext:k,statusSink:e.statusSink,streamOutputCommitted:!1});continue}}}",
      "if(logStream({attempt:u,diagnostics:x,durationMs:Date.now()-c,emittedError:h,emittedEvent:p,logger:e.logger,outboundHeaders:H.headers,statusContext:k}),!h){let de=Date.now(),le=await fhr(W);",
      "await Ac({...k,attempt:u,durationMs:de-c,requestHeaderCount:U,requestHeaders:F,responseHeaderCount:Object.keys(le).length,responseHeaders:le,providerRequestId:m2e(le),finishReason:x.finishReason,usage:x.usage,timeToFirstProviderEventMs:Z,timeToFirstContentMs:J,timeToFirstTextMs:Q,streamMaxIdleMs:X||void 0,streamStallCount:V,streamOutputCommitted:z,timestamp:new Date(de).toISOString(),type:\"model_request_completed\"},_A(e)),O=!0}",
      "r&&P&&await Yrt({modelIoFullRetentionEnabled:e.modelIoFullRetentionEnabled,attempt:u,debugDir:e.debugDir,isDev:n,normalizedToolCalls:S.snapshotNormalizedToolCalls(),options:P,recordModelIO:r,request:b,requestId:k.requestId,resolved:H,result:W,startedAt:c});return}"
    ].join("");
    const source = `${runtime}${runner}`;

    expect(hasRuntimeStreamEofFinishGuard(source)).toBe(false);
    const patched = patchRuntimeStreamEofFinishGuard(source);

    expect(patched).toContain("function $zStreamEofFinishGuard(e){");
    expect(patched).toContain("e.rawFinishReason==null");
    expect(patched).toContain('name:"ModelStreamIdleTimeoutError",code:"MODEL_STREAM_IDLE_TIMEOUT"');
    expect(patched).toContain('continue}}}if($zStreamEofFinishGuard(x)&&!h)throw Object.assign');
    expect(patched).not.toContain("$zStreamEofFinishGuard(z)");
    expect(patched).toContain('if(logStream({attempt:u,diagnostics:x');
    expect(hasRuntimeStreamEofFinishGuard(patched)).toBe(true);
    expect(hasRuntimeStreamEofFinishGuard(
      patched.replace("e.textDeltaChars>0", "e.textDeltaChars>=0")
    )).toBe(false);
    expect(patchRuntimeStreamEofFinishGuard(patched)).toBe(patched);
    expect(() => patchRuntimeStreamEofFinishGuard("incompatible runtime")).toThrow(
      /stream EOF guard patch/
    );

    // The guard must classify the SDK's synthetic "other" finish (null
    // finish_reason) and a missing reason as EOF, while trusting a provider
    // supplied raw finish reason.
    const guardSource = patched.slice(
      patched.indexOf("function $zStreamEofFinishGuard(e){"),
      patched.indexOf("async function*streamRunner(e){")
    );
    const guard = new Function(`${guardSource};return $zStreamEofFinishGuard;`)() as (
      diagnostics: Record<string, unknown>
    ) => boolean;
    expect(guard({ finishReason: void 0, textDeltaChars: 3, toolCallCount: 0, reasoningDeltaChars: 0 })).toBe(true);
    expect(guard({ finishReason: "other", rawFinishReason: void 0, textDeltaChars: 3, toolCallCount: 0, reasoningDeltaChars: 0 })).toBe(true);
    expect(guard({ finishReason: "other", rawFinishReason: "other", textDeltaChars: 3, toolCallCount: 0, reasoningDeltaChars: 0 })).toBe(false);
    expect(guard({ finishReason: "other", rawFinishReason: "provider_done", textDeltaChars: 3, toolCallCount: 0, reasoningDeltaChars: 0 })).toBe(false);
    expect(guard({ finishReason: "stop", rawFinishReason: "stop", textDeltaChars: 3, toolCallCount: 0, reasoningDeltaChars: 0 })).toBe(false);
    expect(guard({ finishReason: "other", rawFinishReason: void 0, textDeltaChars: 0, toolCallCount: 0, reasoningDeltaChars: 0 })).toBe(false);
    expect(guard({ finishReason: void 0, textDeltaChars: 0, toolCallCount: 0, reasoningDeltaChars: 0 })).toBe(false);
    expect(guard({
      finishReason: "other",
      rawFinishReason: void 0,
      textDeltaChars: 0,
      toolCallCount: 0,
      reasoningDeltaChars: 0,
      chunkCounts: { "tool-input-start": 1 }
    })).toBe(true);
  });
});
