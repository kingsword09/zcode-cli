import { expect, test } from "bun:test";

import { RuntimeRpc } from "../packages/zcode-tui/src/runtime-rpc.ts";
import { DynamicWorkflows } from "../packages/zcode-tui/src/dynamic-workflows.ts";

function connection() {
  const frontend = new RuntimeRpc(message => queueMicrotask(() => backend.receive(structuredClone(message))));
  const backend = new RuntimeRpc(message => queueMicrotask(() => frontend.receive(structuredClone(message))));
  return { frontend, backend, close: () => { frontend.close(); backend.close(); } };
}

test("local runtime IPC preserves collections and awaits streaming and permission callbacks", async () => {
  const peers = connection();
  const events: unknown[] = [];
  try {
    peers.backend.register("submit", async (input, options) => {
      const call = options as { onEvent: (event: unknown) => Promise<void>; requestPermission: (request: unknown) => Promise<unknown> };
      await call.onEvent({ input, bytes: new Uint8Array([1, 2]), absent: undefined });
      const permission = await call.requestPermission({ tool: "Write" });
      return { permission, set: new Set(["one"]), map: new Map([["key", 3]]), large: "output".repeat(50_000) };
    });
    const result = await peers.frontend.call("submit", "hello", {
      onEvent: async (event: unknown) => { await Promise.resolve(); events.push(event); },
      requestPermission: async () => ({ decision: "deny" })
    }) as Record<string, unknown>;
    expect(events).toEqual([{ input: "hello", bytes: new Uint8Array([1, 2]), absent: undefined }]);
    expect(result.permission).toEqual({ decision: "deny" });
    expect(result.set).toEqual(new Set(["one"]));
    expect(result.map).toEqual(new Map([["key", 3]]));
    expect(result.large).toBe("output".repeat(50_000));
  } finally { peers.close(); }
});

test("local runtime IPC delivers live and already-aborted signals to permission dialogs", async () => {
  const peers = connection();
  try {
    peers.backend.register("run", async (callback) => {
      const controller = new AbortController();
      const pending = (callback as (context: unknown) => Promise<unknown>)({ signal: controller.signal });
      queueMicrotask(() => controller.abort("permission settled elsewhere"));
      return await pending;
    });
    const result = await peers.frontend.call("run", async (context: { signal: AbortSignal }) => {
      expect(context.signal).toBeInstanceOf(AbortSignal);
      if (!context.signal.aborted) await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return context.signal.reason;
    });
    expect(result).toBe("permission settled elsewhere");
    peers.backend.register("aborted", context => (context as { signal: AbortSignal }).signal.aborted);
    expect(await peers.frontend.call("aborted", { signal: AbortSignal.abort("already cancelled") })).toBe(true);
  } finally { peers.close(); }
});

test("local runtime IPC keeps error names and fails pending calls and signals on disconnect", async () => {
  const peers = connection();
  let remoteSignal: AbortSignal | undefined;
  try {
    peers.backend.register("invalid", () => { const error = new Error("migration failed"); error.name = "SqliteSessionMigrationError"; throw error; });
    await expect(peers.frontend.call("invalid")).rejects.toMatchObject({ name: "SqliteSessionMigrationError", message: "migration failed" });
    peers.backend.register("wait", context => {
      remoteSignal = (context as { signal: AbortSignal }).signal;
      return new Promise(resolve => remoteSignal!.addEventListener("abort", () => resolve(undefined), { once: true }));
    });
    const pending = peers.frontend.call("wait", { signal: new AbortController().signal });
    await Promise.resolve();
    peers.backend.close(new Error("backend gone"));
    peers.frontend.close(new Error("backend gone"));
    await expect(pending).rejects.toThrow("backend gone");
    expect(remoteSignal?.aborted).toBe(true);
    await expect(peers.frontend.call("invalid")).rejects.toThrow("backend gone");
  } finally { peers.close(); }
});

test("local runtime IPC rejects unavailable methods, cycles and oversized request depth", async () => {
  const peers = connection();
  try {
    await expect(peers.frontend.call("__proto__")).rejects.toThrow("unavailable");
    peers.backend.register("identity", value => value);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(peers.frontend.call("identity", circular)).rejects.toThrow("deeply nested");
    expect(await peers.frontend.call("identity", "still works")).toBe("still works");
  } finally { peers.close(); }
});

test("local runtime IPC rejects a malformed response instead of leaving its caller pending", async () => {
  let request: Record<string, unknown> | undefined;
  const peer = new RuntimeRpc(message => { request = message as Record<string, unknown>; });
  const pending = peer.call("read");
  peer.receive({ protocol: "zcode-tui/1", type: "result", id: request!.id, value: { kind: "invalid" } });
  await expect(pending).rejects.toThrow("Invalid runtime collection");
});

test("workflow reducers serialize asynchronous IPC reductions and ignore reset-era results", async () => {
  const releases: Array<() => void> = [];
  const workflows = new DynamicWorkflows({
    reduceWorkflowRuns: async (_state, event) => {
      await new Promise<void>(resolve => releases.push(resolve));
      return { runs: [{ runId: (event as { runId: string }).runId }] };
    }
  });
  const first = workflows.accept({ runId: "old", eventType: "start", sequence: 1 });
  await Promise.resolve();
  workflows.reset();
  releases.shift()!();
  expect(await first).toBe(false);
  expect(workflows.runs()).toEqual([]);
  const second = workflows.accept({ runId: "new", eventType: "start", sequence: 1 });
  await Promise.resolve();
  releases.shift()!();
  expect(await second).toBe(true);
  expect(workflows.runs()).toEqual([{ runId: "new" }]);
});

test("workflow replay and concurrent live progress keep asynchronous reducer order", async () => {
  const order: number[] = [];
  const workflows = new DynamicWorkflows({
    replayWorkflowRuns: async () => [{ runId: "run", eventType: "start", sequence: 1 }],
    listWorkflowRuns: async () => [],
    reduceWorkflowRuns: async (state, event) => {
      await Promise.resolve();
      const sequence = (event as { sequence: number }).sequence;
      const previous = (state as { runs: Array<{ sequence: number }> } | undefined)?.runs[0]?.sequence ?? 0;
      expect(sequence).toBe(previous + 1);
      order.push(sequence);
      return { runs: [{ runId: "run", sequence }] };
    }
  });
  const hydration = workflows.hydrate();
  await workflows.accept({ runId: "run", eventType: "progress", sequence: 2 });
  await hydration;
  await Promise.all([
    workflows.accept({ runId: "run", eventType: "progress", sequence: 3 }),
    workflows.accept({ runId: "run", eventType: "finish", sequence: 4 })
  ]);
  expect(order).toEqual([1, 2, 3, 4]);
  expect(workflows.runs()).toEqual([{ runId: "run", sequence: 4 }]);
});
