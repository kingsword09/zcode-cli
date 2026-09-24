import { describe, expect, test } from "bun:test";
import { RuntimeContextCache } from "../packages/zcode-tui/src/runtime-context-cache.ts";
import { runtimeContextChanged, runtimeContextRefreshNeeded } from "../packages/zcode-tui/src/runtime-poll.ts";
import { normalizeRuntimeProjection } from "../packages/zcode-tui/src/runtime-projection.ts";

function messages(input: number, read = 0): unknown[] {
  return [{ info: { id: "assistant-1", role: "assistant", tokens: { input, cache: { read, write: 0 } } },
    parts: [{ type: "tool", output: "Large tool output does not belong in the cached summary" }] }];
}

describe("runtime context cache", () => {
  test("polls reuse a compact summary until usage is invalidated", async () => {
    const cache = new RuntimeContextCache();
    let reads = 0;
    const load = async () => { reads++; return messages(100, 80); };
    const first = await cache.read("session-1", load);
    expect(first?.latestHitRate).toBe(0.8);
    for (let index = 0; index < 100; index++) expect(await cache.read("session-1", load)).toBe(first);
    expect(reads).toBe(1);
    expect(JSON.stringify(first)).not.toContain("Large tool output");
    cache.invalidate();
    await cache.read("session-1", load);
    expect(reads).toBe(2);
  });

  test("empty sessions are cached and failed reads can be retried", async () => {
    const cache = new RuntimeContextCache();
    let reads = 0;
    const empty = async () => { reads++; return []; };
    expect(await cache.read("empty", empty)).toBeUndefined();
    expect(await cache.read("empty", empty)).toBeUndefined();
    expect(reads).toBe(1);
    cache.invalidate();
    await expect(cache.read("empty", async () => { throw new Error("Store unavailable"); })).rejects.toThrow("Store unavailable");
    expect((await cache.read("empty", async () => messages(200)))?.inputTokens).toBe(200);
  });

  test.each(["invalidate", "reset", "switch"] as const)("ignores an in-flight read after %s", async (action) => {
    const cache = new RuntimeContextCache();
    let resolve!: (value: unknown) => void;
    let reads = 0;
    const load = () => { reads++; return new Promise<unknown>((done) => { resolve = done; }); };
    const old = cache.read("old", load);
    const duplicate = cache.read("old", load);
    await Promise.resolve();
    expect(reads).toBe(1);
    if (action === "invalidate") cache.invalidate();
    if (action === "reset") cache.reset();
    const session = action === "switch" ? "new" : "old";
    expect((await cache.read(session, async () => messages(200, 20)))?.latestHitRate).toBe(0.1);
    resolve(messages(100, 80));
    expect(await old).toBeUndefined();
    expect(await duplicate).toBeUndefined();
    expect((await cache.read(session, load))?.inputTokens).toBe(200);
  });

  test("invalidates on completed requests and history changes, not presentation events", () => {
    for (const type of ["model_complete", "turn_complete", "session_resumed", "session_forked", "session_compacted", "rewind_triggered"]) {
      expect(runtimeContextRefreshNeeded({ type })).toBeTrue();
    }
    for (const type of ["model_streaming", "part.delta", "tool_call_progress", "background_task_updated"]) {
      expect(runtimeContextRefreshNeeded({ type })).toBeFalse();
    }
    const projection = (value: Record<string, unknown>) => normalizeRuntimeProjection({ sessionId: "s", totalTokenCount: 100, ...value });
    expect(runtimeContextChanged(projection({}), projection({ status: "running" }))).toBeFalse();
    expect(runtimeContextChanged(projection({}), projection({ totalTokenCount: 200 }))).toBeTrue();
    expect(runtimeContextChanged(projection({}), projection({ sessionId: "next" }))).toBeTrue();
  });
});
