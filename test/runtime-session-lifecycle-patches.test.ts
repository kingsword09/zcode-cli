import { describe, expect, test } from "bun:test";
import {
  hasRuntimeSessionLifecycle, patchRuntimeSessionLifecycle
} from "../scripts/runtime-session-lifecycle-patches.ts";
import { runtimePatchPlan } from "../scripts/sync-runtime.ts";
import { assertResumableSession, ensureSessionForTitle, readSessionResumeTarget } from "../src/runtime-session-lifecycle.ts";

function fixture(): string {
  return `const label=fn=>fn;
async function nativeTitle(input){await this.sessionStore.updateSession({id:this.sessionId,title:input.title,titleSource:"custom"})}
label(nativeTitle,"setCustomSessionTitle");
async function create(options){let owns=options.sessionStore===void 0,store=options.sessionStore??await open(config,timer),ready=true;return ready}
const facade={setCustomSessionTitle:label(async input=>context.runtime.setCustomSessionTitle({title:input.title,traceContext:input.traceContext??context.traceContext}),"setCustomSessionTitle")};
const state={},view=value=>value,snapshot=value=>value;let current;
const replace=label(async factory=>{let previous=current,candidate=await factory();return current=candidate,previous&&previous!==candidate&&await close(previous),state.current=view(current,snapshot(state)),current},"replaceApp");
const make=label(async factory=>{let candidate=await factory();return state.current=view(candidate,snapshot(state)),candidate},"createApp");
const locale={locale:"en-US"},resumeOptions=context.resumeOptions??{},unused={},prepare=()=>context;
const handler=prepare(unused,unused,unused,resumeOptions,locale.locale,unused);
const shutdown={cleanup:label(async()=>{await handler.close?.()},"cleanup")};
const run=()=>({started:true}),config={},timer={},open=async()=>context.ownedStore;
async function start(){try{return await run({loadStartupOptions:()=>({})})}finally{await shutdown.cleanup()}}
return {nativeTitle,facade,create,replace,make,start,read:()=>({current,visible:state.current})};`;
}

function load(source: string, context: object, close: (app: unknown) => Promise<void> = async () => {}) {
  return new Function("require", "__dirname", "context", "close", source)(
    (name: string) => name === "node:path" ? { join: (...parts: string[]) => parts.join("/") }
      : { ensureSessionForTitle, assertResumableSession, readSessionResumeTarget },
    "/fixture", context, close
  );
}

describe("session lifecycle runtime patch", () => {
  test("is required, executable, idempotent, and fails closed on incompatible anchors", () => {
    const patched = patchRuntimeSessionLifecycle(fixture());
    expect(hasRuntimeSessionLifecycle(patched)).toBeTrue();
    expect(patchRuntimeSessionLifecycle(patched)).toBe(patched);
    expect(() => new Function(patched)).not.toThrow();
    expect(runtimePatchPlan.find(patch => patch.id === "session-lifecycle")?.requirement).toBe("required");
    expect(() => patchRuntimeSessionLifecycle("incompatible")).toThrow("missing or ambiguous");
    expect(() => patchRuntimeSessionLifecycle(fixture() + fixture())).toThrow("ambiguous");
  });

  test("persists before a title write and skips the write after persistence failure", async () => {
    const calls: string[] = [];
    let session: object | null = null;
    const runtime = {
      sessionId: "session", rootTraceContext: {},
      sessionStore: {
        getSession: async () => session,
        updateSession: async () => { calls.push("title"); }
      },
      ensureSessionPersistedForExternalActivity: async () => { calls.push("persist"); session = {}; }
    };
    const api = load(patchRuntimeSessionLifecycle(fixture()), { runtime });
    await api.nativeTitle.call(runtime, { title: "chosen" });
    expect(calls).toEqual(["persist", "title"]);
    expect(await api.facade.readSessionResumeTarget()).toBe("session");
    runtime.ensureSessionPersistedForExternalActivity = async () => { throw new Error("Write failed"); };
    await expect(api.nativeTitle.call(runtime, { title: "failed" })).rejects.toThrow("Write failed");
    expect(calls).toEqual(["persist", "title"]);
  });

  test("validates a replacement before publishing it or closing the previous app", async () => {
    const closed: unknown[] = [];
    const api = load(patchRuntimeSessionLifecycle(fixture()), {}, async app => { closed.push(app); });
    const previous = { readExecutionState: async () => ({ mode: "build" }) };
    await api.replace(() => api.make(async () => previous));
    const invalid = { readExecutionState: async () => { throw new Error("Session not found: missing"); } };
    await expect(api.replace(() => api.make(async () => invalid))).rejects.toThrow("Session not found: missing");
    expect(api.read()).toEqual({ current: previous, visible: previous });
    expect(closed).toEqual([invalid]);
  });

  test("checks a resumed target without creating a replacement session", async () => {
    const api = load(patchRuntimeSessionLifecycle(fixture()), {});
    const store = { getSession: async () => null };
    await expect(api.create({ resume: true, sessionId: "missing", sessionStore: store })).rejects.toThrow("Session not found: missing");
    expect(await api.create({ sessionStore: store })).toBeTrue();
  });

  test("closes an owned store when startup resume validation fails", async () => {
    let closed = false;
    const api = load(patchRuntimeSessionLifecycle(fixture()), { ownedStore: {
      getSession: async () => null, close: async () => { closed = true; }
    } });
    await expect(api.create({ resume: true, sessionId: "missing" })).rejects.toThrow("Session not found: missing");
    expect(closed).toBeTrue();
  });

  test("gates only resume startup and cleans up without constructing a broken TUI", async () => {
    const calls: string[] = [];
    const context = {
      resumeOptions: { resumeSessionId: "missing" },
      readExecutionState: async () => { calls.push("validate"); throw new Error("Session not found: missing"); },
      close: async () => { calls.push("close"); }
    };
    const api = load(patchRuntimeSessionLifecycle(fixture()), context);
    await expect(api.start()).rejects.toThrow("Session not found: missing");
    expect(calls).toEqual(["validate", "close"]);
    const fresh = load(patchRuntimeSessionLifecycle(fixture()), { ...context, resumeOptions: {} });
    expect(await fresh.start()).toEqual({ started: true });
    expect(calls).toEqual(["validate", "close", "close"]);
  });
});
