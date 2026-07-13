import { describe, expect, test } from "bun:test";

import {
  normalizeRuntimeProjection,
  normalizeTodoGroups,
  normalizeTodos
} from "../packages/zcode-tui/src/runtime-projection.ts";

describe("runtime projection normalization", () => {
  test("normalizes internal runtime projections and background tasks", () => {
    const snapshot = normalizeRuntimeProjection({
      id: "session-1",
      status: "running",
      mode: "build",
      turnCount: 3,
      totalTokenCount: 8_200,
      contextUsed: 45_000,
      contextWindow: 200_000,
      lastError: { type: "provider", code: "RATE_LIMIT", message: "Retry later", detail: "429" },
      currentTurnId: "turn-3",
      activeToolCalls: [{
        toolCallId: "tool-1",
        toolName: "Bash",
        status: "running",
        startedAt: new Date("2026-07-14T01:00:00Z")
      }],
      backgroundTasks: [{
        taskId: "bg-1",
        toolCallId: "tool-1",
        toolName: "Bash",
        description: "Run tests",
        command: "bun test",
        status: "running",
        cancellable: true,
        pid: 42,
        stdoutBytes: 512,
        stdoutTail: "81 pass"
      }]
    });

    expect(snapshot?.sessionId).toBe("session-1");
    expect(snapshot?.contextUsage).toMatchObject({ used: 45_000, size: 200_000 });
    expect(snapshot?.lastError).toEqual({ type: "provider", code: "RATE_LIMIT", message: "Retry later", detail: "429" });
    expect(snapshot?.activeToolCalls[0]).toMatchObject({ toolCallId: "tool-1", toolName: "Bash" });
    expect(snapshot?.backgroundJobs[0]).toMatchObject({
      taskId: "bg-1",
      command: "bun test",
      status: "running",
      stdoutTail: "81 pass"
    });
  });

  test("preserves protocol context breakdown and cache usage", () => {
    const snapshot = normalizeRuntimeProjection({
      projection: {
        sessionId: "session-2",
        contextUsed: 2_000,
        contextWindow: 10_000,
        activeToolCalls: [],
        backgroundJobs: []
      },
      runtime: {
        contextUsage: {
          used: 2_100,
          size: 10_000,
          cost: { amount: 0.12, currency: "USD" },
          cache: {
            inputTokens: 2_100,
            cacheReadTokens: 800,
            cacheWriteTokens: 50,
            hitRate: 0.38,
            hitRateRequestCount: 3,
            totalInputTokens: 6_000,
            totalCacheReadTokens: 2_000,
            totalCacheWriteTokens: 100
          },
          breakdown: [
            { source: "system_prompt", chars: 2_000 },
            { source: "messages", chars: 6_400 },
            { source: "invalid", chars: 900 }
          ]
        }
      }
    });

    expect(snapshot?.contextUsage).toEqual({
      used: 2_100,
      size: 10_000,
      cost: { amount: 0.12, currency: "USD" },
      cache: {
        inputTokens: 2_100,
        cacheReadTokens: 800,
        cacheWriteTokens: 50,
        latestHitRate: undefined,
        hitRate: 0.38,
        hitRateRequestCount: 3,
        totalInputTokens: 6_000,
        totalCacheReadTokens: 2_000,
        totalCacheWriteTokens: 100
      },
      breakdown: [
        { source: "system_prompt", chars: 2_000 },
        { source: "messages", chars: 6_400 }
      ]
    });
  });

  test("normalizes todos and official todo groups", () => {
    const todos = normalizeTodos({
      todos: [
        { content: "Implement projection", status: "in_progress", priority: "high" },
        { content: "Run tests", status: "pending", priority: "low" },
        { content: "Ignore invalid", status: "unknown", priority: "low" }
      ]
    });
    expect(todos).toHaveLength(2);
    expect(todos[0]?.priority).toBe("high");

    expect(normalizeTodoGroups({
      todoGroups: [{
        id: "goal-2",
        source: "goal_iteration",
        goalIteration: 2,
        targetId: "target-1",
        todos
      }]
    })).toEqual([{
      id: "goal-2",
      source: "goal_iteration",
      goalIteration: 2,
      targetId: "target-1",
      startedAt: undefined,
      updatedAt: undefined,
      todos
    }]);
  });
});
