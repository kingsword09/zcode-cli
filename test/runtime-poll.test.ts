import { describe, expect, test } from "bun:test";

import {
  ACTIVE_RUNTIME_POLL_INTERVAL_MS,
  IDLE_RUNTIME_POLL_INTERVAL_MS,
  runtimePollInterval,
  runtimeRefreshNeeded,
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

  test("does not refresh runtime projection for presentation-only text deltas", () => {
    expect(runtimeRefreshNeeded({ kind: "text_delta" })).toBeFalse();
    expect(runtimeRefreshNeeded({ kind: "reasoning_delta" })).toBeFalse();
    expect(runtimeRefreshNeeded({ type: "part.delta", field: "text" })).toBeFalse();
    expect(runtimeRefreshNeeded({ type: "part.delta", field: "reasoning" })).toBeFalse();
    expect(runtimeRefreshNeeded({ type: "part.delta", field: "input" })).toBeFalse();
    expect(runtimeRefreshNeeded({ type: "part.delta", field: "output" })).toBeFalse();
    expect(runtimeRefreshNeeded({ kind: "tool_input_delta" })).toBeFalse();
    expect(runtimeRefreshNeeded({ type: "part.started" })).toBeTrue();
    expect(runtimeRefreshNeeded({ kind: "progress" })).toBeTrue();
    expect(runtimeRefreshNeeded({ kind: "result" })).toBeTrue();

    const presentationDeltas = Array.from({ length: 10_000 }, (_, index) => index % 2 === 0
      ? { kind: "tool_input_delta" }
      : { type: "part.delta", field: index % 4 === 1 ? "input" as const : "output" as const });
    expect(presentationDeltas.filter(runtimeRefreshNeeded)).toHaveLength(0);
  });
});
