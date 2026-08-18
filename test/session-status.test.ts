import { describe, expect, test } from "bun:test";

import {
  contextRemainingPercent,
  contextUsedPercent,
  mergeMetrics,
  mergeProjectionMetrics,
  projectionMetrics,
  sessionIdFromUsage,
  usageMetrics
} from "../packages/zcode-tui/src/session-status.ts";

describe("TUI session status", () => {
  test("normalizes projection and detailed usage snapshots", () => {
    expect(projectionMetrics({
      contextUsed: 32_000,
      contextWindow: 128_000,
      totalTokenCount: 18_400,
      turnCount: 4
    })).toEqual({
      contextUsed: 32_000,
      contextWindow: 128_000,
      totalTokens: 18_400,
      turnCount: 4
    });
    expect(usageMetrics({
      totalTokens: 18_500,
      inputTokens: 14_000,
      outputTokens: 4_000,
      reasoningTokens: 500,
      cacheReadTokens: 9_000
    })).toMatchObject({ totalTokens: 18_500, inputTokens: 14_000, cacheReadTokens: 9_000 });
  });

  test("merges authoritative updates and computes bounded context remaining", () => {
    const metrics = mergeMetrics(
      { contextUsed: 32_000, contextWindow: 128_000, totalTokens: 18_400 },
      { totalTokens: 18_500, inputTokens: 14_000 }
    );
    expect(metrics.totalTokens).toBe(18_500);
    expect(metrics.contextUsed).toBe(32_000);
    expect(contextRemainingPercent(metrics)).toBe(75);
    expect(contextRemainingPercent({ contextUsed: 200, contextWindow: 100 })).toBe(0);
  });

  test("keeps session-store totals authoritative over runtime projections", () => {
    const usage = { totalTokens: 18_500, inputTokens: 14_000 };
    const projection = { totalTokens: 417_202, contextUsed: 32_000, contextWindow: 128_000 };

    expect(mergeProjectionMetrics(usage, projection, true)).toEqual({
      totalTokens: 18_500,
      inputTokens: 14_000,
      contextUsed: 32_000,
      contextWindow: 128_000
    });
    expect(mergeProjectionMetrics({}, projection, false).totalTokens).toBe(417_202);
  });

  test("does not erase metrics with absent fields and keeps used plus remaining at 100%", () => {
    expect(mergeMetrics(
      { totalTokens: 18_500, contextUsed: 32_000 },
      { contextWindow: 128_000, totalTokens: undefined }
    )).toEqual({ totalTokens: 18_500, contextUsed: 32_000, contextWindow: 128_000 });

    const metrics = { contextUsed: 1, contextWindow: 8 };
    expect(contextUsedPercent(metrics)).toBe(13);
    expect(contextRemainingPercent(metrics)).toBe(87);
  });

  test("extracts the official session identifier from usage snapshots", () => {
    expect(sessionIdFromUsage({ sessionId: "sess_protocol" })).toBe("sess_protocol");
    expect(sessionIdFromUsage({ sessionID: "sess_store" })).toBe("sess_store");
    expect(sessionIdFromUsage({ totalTokens: 10 })).toBeUndefined();
  });
});
