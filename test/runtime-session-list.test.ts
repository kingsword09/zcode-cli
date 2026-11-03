import { describe, expect, test } from "bun:test";
import { listSessionsForPicker } from "../src/runtime-session-lifecycle.ts";

function fakeStore(rows: Parameters<typeof Object>[0][] = []) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    listSessions(options: Record<string, unknown>) {
      calls.push(options);
      return Promise.resolve(rows);
    }
  };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "sess_a",
  title: "Session A",
  directory: "/tmp/project",
  parentID: null,
  time: { created: 1_000, updated: 2_000 },
  ...overrides
});

describe("listSessionsForPicker", () => {
  test("maps store rows to picker entries with camelCase fields", async () => {
    const store = fakeStore([
      row(),
      row({ id: "sess_fork", title: "", parentID: "sess_a", time: { created: 5_000 } })
    ]);
    const entries = await listSessionsForPicker({ directory: "/tmp/project", sessionStore: store as never });
    expect(entries).toEqual([
      { id: "sess_a", title: "Session A", directory: "/tmp/project", updatedAt: 2_000, parentId: null },
      { id: "sess_fork", title: "", directory: "/tmp/project", updatedAt: 5_000, parentId: "sess_a" }
    ]);
    expect(store.calls).toEqual([{
      directory: "/tmp/project",
      limit: 50,
      taskTypes: ["interactive", "fork", "workflow_parent"]
    }]);
  });

  test("prefers the direct session store over the runtime one", async () => {
    const direct = fakeStore([row({ id: "sess_direct" })]);
    const nested = fakeStore([row({ id: "sess_nested" })]);
    const entries = await listSessionsForPicker({
      directory: "/tmp/project",
      sessionStore: direct as never,
      runtime: { sessionStore: nested as never }
    });
    expect(entries.map((entry) => entry.id)).toEqual(["sess_direct"]);
  });

  test("falls back to the runtime's directory and store", async () => {
    const store = fakeStore([row()]);
    await listSessionsForPicker({ runtime: { directory: "/tmp/other", sessionStore: store as never } });
    expect(store.calls[0]?.directory).toBe("/tmp/other");
  });

  test("returns an empty list without a store instead of throwing", async () => {
    expect(await listSessionsForPicker({})).toEqual([]);
    expect(await listSessionsForPicker({ sessionStore: {} as never })).toEqual([]);
  });

  test("falls back to process.cwd() when no directory is known", async () => {
    const store = fakeStore([row()]);
    await listSessionsForPicker({ sessionStore: store as never });
    expect(store.calls[0]?.directory).toBe(process.cwd());
  });
});
