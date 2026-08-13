import { describe, expect, test } from "bun:test";

import {
  chooseArtifact,
  manifestUrl,
  parseArgs,
  parseRuntimeLock,
  patchRuntimeAgentAutoBackground,
  patchRuntimeBackgroundTaskProjection,
  patchRuntimeDetachedAgentLifecycle,
  patchRuntimeTerminalToolProjection,
  patchRuntimeOAuthHttpErrors,
  patchRuntimeTuiBridge,
  patchRuntimeZaiDesktopOAuth,
  resolveArtifactUrl,
  resolveLatestRuntimeLock,
  selectRuntimeLock,
  serviceManifestUrl,
  serviceReleasePlatform,
  supportsMultiMessageFileRewind
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

  test("injects transcript and structured state readers into the official TUI adapter", () => {
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
    expect(patched).toContain("E.listSkills=async()=>await H(e)");
    expect(patched).toContain("E.readGoal=async()=>await(await S()).readTarget?.()??null");
    expect(patched).toContain("E.readTodos=async()=>await(await S()).readTodos?.()??[]");
    expect(patched).toContain("E.readRuntimeProjection=async()=>{let e=await S(),t=await e.runtime?.getProjection?.();if(!t)return null;");
    expect(patched).toContain(".filter(o=>o.isBackgrounded===!0).map(o=>");
    expect(patched).toContain("backgroundTaskDetails:r");
    expect(patched).toContain("E.readSessionUsage=async()=>await(await S()).readSessionUsage?.()??null");
    expect(patched).toContain("E.cancelBackgroundTask=async e=>await(await S()).cancelBackgroundTask?.(e)??null");
    expect(patched).toContain("E.subscribeSessionEvents=e=>{let t=!1,r;S().then(o=>{t||(r=o.runtime?.subscribeEvents?.({onSessionEvent:e}))});return()=>{t=!0,r?.()}}");
    expect(patched).toContain("E.sendBackgroundTaskMessage=async e=>");
    expect(patched).toContain('if(e?.restart===!0&&o.status==="running")');
    expect(patched).toContain("await r.subagentPort.stopTask(e.taskId)");
    expect(patched).toContain("r.subagentPort.sendMessage({sessionId:o.parentSessionId??r.getSessionId?.()");
    expect(patched).toContain("E.previewFileRewind=async e=>{let t=await S();return await t.runtime?.previewWorkspaceFileRewind?.({targetMessageIds:e})??null}");
    expect(patched).toContain("E.applyFileRewind=async e=>{let t=await S();return await t.runtime?.applyWorkspaceFileRewind?.({targetMessageIds:e})??null}");
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
    expect(patched).toContain("readSessionUsage:g.readSessionUsage");
    expect(patched).toContain("cancelBackgroundTask:g.cancelBackgroundTask");
    expect(patched).toContain("previewFileRewind:g.previewFileRewind");
    expect(patched).toContain("applyFileRewind:g.applyFileRewind");
    expect(patched).toContain("interruptTurn:g.interruptTurn");
    expect(patched).toContain("promoteQueuedInput:g.promoteQueuedInput");
    expect(patched).toContain("listSkills:g.listSkills");
    expect(patched).toContain("subscribeSessionEvents:g.subscribeSessionEvents");
    expect(patched).toContain("sendBackgroundTaskMessage:g.sendBackgroundTaskMessage");
    expect(patched).toContain("sessionStore.queryTaskUsage?.({sessionID:e.sessionId})");
    expect(patchRuntimeTuiBridge(patched)).toBe(patched);
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

  test("keeps foreground agents out of the background task projection", () => {
    const runtime = "function project(e){return Object.values(e.runtime?.runtimeTaskRegistry?.all?.()??{}).map(o=>o.taskId)}";
    const patched = patchRuntimeBackgroundTaskProjection(runtime);
    const project = new Function(`${patched};return project;`)() as (app: unknown) => string[];
    const app = {
      runtime: {
        runtimeTaskRegistry: {
          all: () => ({
            foreground: { taskId: "foreground", isBackgrounded: false },
            background: { taskId: "background", isBackgrounded: true }
          })
        }
      }
    };

    expect(project(app)).toEqual(["background"]);
    expect(patchRuntimeBackgroundTaskProjection(patched)).toBe(patched);
    expect(() => patchRuntimeBackgroundTaskProjection("incompatible runtime")).toThrow(/incompatible/);
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
});
