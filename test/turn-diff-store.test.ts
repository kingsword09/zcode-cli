import { describe, expect, test } from "bun:test";

import {
  MAX_RETAINED_TURN_DIFFS,
  TurnDiffStore
} from "../packages/zcode-tui/src/turn-diff-store.ts";

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

  test("releases completed empty turns while preserving chronological indexes", () => {
    const store = new TurnDiffStore();
    const internal = store as unknown as {
      current?: unknown;
      turns: unknown[];
    };

    for (let turn = 0; turn < 1_000; turn += 1) {
      store.beginTurn(`Read only ${turn}`);
      store.finishTurn();
    }
    expect(internal.turns).toHaveLength(0);
    expect(internal.current).toBeUndefined();

    store.beginTurn("Mutation after read-only turns");
    store.upsertTool("call_mutation", [diff("changed.ts", 2)]);
    store.finishTurn();
    expect(store.snapshots()[0]).toMatchObject({
      index: 1_001,
      prompt: "Mutation after read-only turns"
    });

    store.clear();
    store.beginTurn("First after clear");
    store.upsertTool("call_after_clear", [diff("reset.ts", 1)]);
    expect(store.snapshots()[0]?.index).toBe(1);
  });

  test("retains only the newest completed mutation turns", () => {
    const store = new TurnDiffStore();
    for (let turn = 1; turn <= 100; turn += 1) {
      store.beginTurn(`Mutation ${turn}`);
      store.upsertTool(`call_${turn}`, [diff(`file_${turn}.ts`, turn)]);
      store.finishTurn();
    }

    const snapshots = store.snapshots();
    expect(snapshots).toHaveLength(MAX_RETAINED_TURN_DIFFS);
    expect(snapshots.map((snapshot) => snapshot.index)).toEqual(
      Array.from({ length: MAX_RETAINED_TURN_DIFFS }, (_, index) => 81 + index)
    );
    expect(snapshots[0]?.prompt).toBe("Mutation 81");
    expect(snapshots.at(-1)?.prompt).toBe("Mutation 100");
  });
});
