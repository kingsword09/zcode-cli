import { describe, expect, test } from "bun:test";

import {
  extractContextCacheTrend,
  findActiveBranchMessageIds
} from "../packages/zcode-tui/src/context-cache.ts";

describe("context cache trend", () => {
  test("keeps request gaps and separates active branch from whole tree", () => {
    const messages = [
      { info: { id: "u-1", role: "user" } },
      { info: { id: "a-1", parentID: "u-1", role: "assistant", tokens: { input: 100, cache: { read: 80, write: 20 } } } },
      { info: { id: "u-2", role: "user" } },
      { info: { id: "a-2", parentID: "u-2", role: "assistant" } },
      { info: { id: "u-branch", role: "user" } },
      { info: { id: "a-branch", parentID: "u-branch", role: "assistant", tokens: { input: 200, cache: { read: 0, write: 200 } } } }
    ];
    const activeIds = findActiveBranchMessageIds(messages);
    const trend = extractContextCacheTrend(messages, activeIds);

    expect(trend.turns).toHaveLength(3);
    expect(trend.turns[0]).toMatchObject({ state: "hit", hitRate: 0.8, active: false });
    expect(trend.turns[1]).toMatchObject({ state: "unknown", active: false });
    expect(trend.turns[2]).toMatchObject({ state: "miss", hitRate: 0, active: true });
    expect(trend.wholeTree).toMatchObject({ requests: 2, inputTokens: 300, cacheReadTokens: 80 });
    expect(trend.active).toMatchObject({ requests: 1, inputTokens: 200, cacheReadTokens: 0, hitRate: 0 });
  });

  test("uses step-finish tokens when assistant message tokens are absent", () => {
    const trend = extractContextCacheTrend([{
      info: { id: "assistant-1", role: "assistant", tokens: { input: 0, cache: { read: 0, write: 0 } } },
      parts: [{ type: "step-finish", tokens: { input: 160, cache: { read: 120, write: 40 } } }]
    }, {
      info: { id: "summary-1", role: "assistant", summary: "compacted", tokens: { input: 500, cache: { read: 500, write: 0 } } }
    }]);
    expect(trend.wholeTree).toMatchObject({ requests: 1, inputTokens: 160, cacheReadTokens: 120, hitRate: 0.75 });
    expect(trend.turns).toHaveLength(1);
    expect(trend.turns[0]).toMatchObject({ state: "hit", hitRate: 0.75 });
  });
});
