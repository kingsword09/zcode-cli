import { describe, expect, test } from "bun:test";

import {
  mergeProjectionContextCache,
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
      taskKind: "local_bash",
      command: "bun test",
      status: "running",
      stdoutTail: "81 pass"
    });
  });

  test("merges runtime task-registry metadata into background projections", () => {
    const snapshot = normalizeRuntimeProjection({
      sessionId: "session-1",
      activeToolCalls: [],
      backgroundTasks: [{
        taskId: "agent-1",
        toolName: "Agent",
        status: "failed",
        description: "Review task recovery"
      }],
      backgroundTaskDetails: [{
        taskId: "agent-1",
        taskKind: "local_agent",
        agentId: "agent-1",
        agentType: "reviewer",
        childSessionId: "child-1",
        parentSessionId: "session-1",
        turnId: "turn-1",
        prompt: "Audit the task flow",
        status: "running",
        error: "Provider unavailable"
      }]
    });

    expect(snapshot?.backgroundJobs[0]).toMatchObject({
      taskId: "agent-1",
      taskKind: "local_agent",
      agentId: "agent-1",
      agentType: "reviewer",
      childSessionId: "child-1",
      prompt: "Audit the task flow",
      status: "running",
      error: "Provider unavailable"
    });
  });

  test("keeps restored background agents whose registry status is stopped", () => {
    // Restored tasks re-register with status "stopped" (or completed/failed read
    // from task metadata.json); "stopped" is a runtime-native terminal status
    // and must survive normalization instead of being dropped from /tasks.
    // The readRuntimeProjection bridge pushes registry rows into backgroundTasks
    // and repeats them as backgroundTaskDetails, so normalize sees both.
    const restoredJob = {
      taskId: "agent-2",
      taskKind: "local_agent",
      agentId: "agent-2",
      agentType: "general-purpose",
      childSessionId: "child-2",
      parentSessionId: "session-1",
      status: "stopped",
      description: "Restored background agent"
    };
    const snapshot = normalizeRuntimeProjection({
      sessionId: "session-1",
      activeToolCalls: [],
      backgroundTasks: [restoredJob],
      backgroundTaskDetails: [restoredJob]
    });

    expect(snapshot?.backgroundJobs[0]).toMatchObject({
      taskId: "agent-2",
      taskKind: "local_agent",
      agentId: "agent-2",
      status: "stopped",
      childSessionId: "child-2"
    });
  });

  test("normalizes the restoration log carried by the projection", () => {
    const snapshot = normalizeRuntimeProjection({
      sessionId: "session-1",
      activeToolCalls: [],
      backgroundTasks: [],
      restoredBackgroundTasks: [{
        taskId: "agent-3",
        taskKind: "local_agent",
        agentId: "agent-3",
        status: "completed",
        description: "Finished while ZCode was closed"
      }]
    });

    expect(snapshot?.restoredBackgroundTasks).toHaveLength(1);
    expect(snapshot?.restoredBackgroundTasks?.[0]).toMatchObject({
      taskId: "agent-3",
      status: "completed"
    });
    expect(normalizeRuntimeProjection({
      sessionId: "session-1",
      activeToolCalls: [],
      backgroundJobs: []
    })?.restoredBackgroundTasks).toEqual([]);
  });

  test("does not let undefined registry fields erase persisted task fields", () => {
    const snapshot = normalizeRuntimeProjection({
      sessionId: "session-1",
      activeToolCalls: [],
      backgroundTasks: [{
        taskId: "agent-3",
        taskKind: "local_agent",
        status: "failed",
        childSessionId: "child-3",
        description: "Persisted task"
      }],
      backgroundTaskDetails: [{
        taskId: "agent-3",
        taskKind: "local_agent",
        status: "running",
        childSessionId: undefined
      }]
    });

    expect(snapshot?.backgroundJobs[0]).toMatchObject({
      taskId: "agent-3",
      status: "running",
      childSessionId: "child-3",
      description: "Persisted task"
    });
  });

  test("keeps the runtime killed status visible after an agent stop", () => {
    const snapshot = normalizeRuntimeProjection({
      sessionId: "session-1",
      activeToolCalls: [],
      backgroundTasks: [{
        taskId: "agent-killed",
        taskKind: "local_agent",
        status: "killed",
        childSessionId: "child-killed"
      }]
    });

    expect(snapshot?.backgroundJobs[0]).toMatchObject({
      taskId: "agent-killed",
      taskKind: "local_agent",
      status: "killed",
      childSessionId: "child-killed"
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

  test("enriches cache usage from persisted step-finish parts without runtime symbols", () => {
    const projection = normalizeRuntimeProjection({
      sessionId: "session-legacy",
      contextUsed: 2_000,
      contextWindow: 10_000,
      activeToolCalls: [],
      backgroundJobs: []
    });
    const enriched = mergeProjectionContextCache(projection, [{
      info: {
        id: "assistant-1",
        role: "assistant",
        tokens: { input: 0, cache: { read: 0, write: 0 } }
      },
      parts: [{
        type: "step-finish",
        tokens: { input: 1_000, cache: { read: 900, write: 25 } }
      }]
    }]);

    expect(enriched?.contextUsage).toMatchObject({
      used: 2_000,
      size: 10_000,
      cache: {
        inputTokens: 1_000,
        cacheReadTokens: 900,
        cacheWriteTokens: 25,
        latestHitRate: 0.9,
        hitRate: 0.9,
        hitRateRequestCount: 1,
        totalInputTokens: 1_000,
        totalCacheReadTokens: 900,
        totalCacheWriteTokens: 25
      }
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
