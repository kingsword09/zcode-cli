import { describe, expect, test } from "bun:test";

import {
  ACTIVE_RUNTIME_POLL_INTERVAL_MS,
  IDLE_RUNTIME_POLL_INTERVAL_MS,
  runtimePollInterval,
  runtimePollStateChanged,
  type RuntimePollState
} from "../packages/zcode-tui/src/runtime-poll.ts";
import { normalizeRuntimeProjection } from "../packages/zcode-tui/src/runtime-projection.ts";

function state(totalTokenCount: number): RuntimePollState {
  return {
    projection: normalizeRuntimeProjection({
      sessionId: "session-1",
      status: "running",
      totalTokenCount,
      activeToolCalls: [],
      backgroundJobs: []
    }),
    todos: [{ content: "Measure CPU", status: "in_progress", priority: "high" }],
    todoGroups: []
  };
}

describe("runtime polling", () => {
  test("polls active turns more frequently than idle sessions", () => {
    expect(runtimePollInterval(true)).toBe(ACTIVE_RUNTIME_POLL_INTERVAL_MS);
    expect(runtimePollInterval(false)).toBe(IDLE_RUNTIME_POLL_INTERVAL_MS);
    expect(ACTIVE_RUNTIME_POLL_INTERVAL_MS).toBe(1_000);
    expect(IDLE_RUNTIME_POLL_INTERVAL_MS).toBe(5_000);
  });

  test("does not report a change for equivalent normalized snapshots", () => {
    expect(runtimePollStateChanged(state(1_000), state(1_000))).toBeFalse();
    expect(runtimePollStateChanged(state(1_000), state(1_001))).toBeTrue();
  });
});
