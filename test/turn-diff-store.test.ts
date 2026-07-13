import { describe, expect, test } from "bun:test";

import { TurnDiffStore } from "../packages/zcode-tui/src/turn-diff-store.ts";

const diff = (filePath: string, additions: number) => ({
  filePath,
  additions,
  deletions: 1,
  structuredPatch: [{ lines: ["-old", "+new"] }]
});

describe("turn diff store", () => {
  test("replaces repeated lifecycle snapshots for the same tool", () => {
    const store = new TurnDiffStore();
    store.beginTurn("Update rendering");
    store.upsertTool("call_1", [diff("first.ts", 1)]);
    store.upsertTool("call_1", [diff("first.ts", 2)]);
    store.upsertTool("call_2", [diff("second.ts", 3)]);

    expect(store.snapshots()[0]).toMatchObject({
      index: 1,
      prompt: "Update rendering",
      additions: 5,
      deletions: 2
    });
    expect(store.snapshots()[0]?.files).toHaveLength(2);
  });

  test("omits turns without file changes", () => {
    const store = new TurnDiffStore();
    store.beginTurn("Read only");
    expect(store.snapshots()).toEqual([]);
  });
});
