import { describe, expect, test } from "bun:test";
import {
  assertResumableSession, ensureSessionForTitle, readSessionResumeTarget,
  type SessionLifecycleRuntime
} from "../src/runtime-session-lifecycle.ts";

describe("runtime session lifecycle", () => {
  test("checks real storage without persisting an empty session", async () => {
    let persisted = false;
    const store = { getSession: async () => persisted ? { time: { created: 1 } } : null };
    const runtime = {
      sessionId: "empty", sessionStore: store,
      ensureSessionPersistedForExternalActivity: async () => { persisted = true; }
    };
    expect(await readSessionResumeTarget({ runtime })).toBeUndefined();
    expect(persisted).toBeFalse();
    await expect(assertResumableSession(store, "empty")).rejects.toThrow("Session not found: empty");
    await ensureSessionForTitle(runtime, { title: "Chosen title" });
    expect(await readSessionResumeTarget({ runtime })).toBe("empty");
  });

  test("uses the native persistence entry and preserves explicit trace context", async () => {
    const calls: unknown[] = [];
    const rootTraceContext = { traceId: "root" };
    const runtime = {
      sessionId: "session", rootTraceContext,
      sessionStore: { getSession: async () => ({}) },
      async ensureSessionPersistedForExternalActivity(title: string, options: unknown) {
        expect(this).toBe(runtime);
        calls.push({ title, options });
      }
    };
    await ensureSessionForTitle(runtime, { title: "First title" });
    await ensureSessionForTitle(runtime, { title: "Second title", traceContext: { traceId: "explicit" } });
    expect(calls).toEqual([
      { title: "First title", options: { traceContext: rootTraceContext } },
      { title: "Second title", options: { traceContext: { traceId: "explicit" } } }
    ]);
  });

  test("does not treat deleted, missing, or unreadable sessions as resumable", async () => {
    const store = { getSession: async () => ({ time: { deleted: 1 } }) };
    expect(await readSessionResumeTarget({ sessionId: "deleted", sessionStore: store })).toBeUndefined();
    await expect(assertResumableSession(store, "deleted")).rejects.toThrow("Session not found: deleted");
    expect(await readSessionResumeTarget({ sessionId: "id-only" })).toBeUndefined();
    await expect(readSessionResumeTarget({ sessionId: "broken", sessionStore: {
      getSession: async () => { throw new Error("Store unreadable"); }
    } })).rejects.toThrow("Store unreadable");
  });

  test("propagates persistence failures and rejects a persistence no-op", async () => {
    const runtime: SessionLifecycleRuntime = {
      sessionId: "failed", sessionStore: { getSession: async () => null },
      ensureSessionPersistedForExternalActivity: async () => { throw new Error("Write failed"); }
    };
    await expect(ensureSessionForTitle(runtime, { title: "title" })).rejects.toThrow("Write failed");
    runtime.ensureSessionPersistedForExternalActivity = async () => {};
    await expect(ensureSessionForTitle(runtime, { title: "title" })).rejects.toThrow("Session not found: failed");
    await expect(ensureSessionForTitle({}, { title: "title" })).rejects.toThrow("persistence is unavailable");
  });
});
