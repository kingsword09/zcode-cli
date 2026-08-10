import { describe, expect, test } from "bun:test";

import type { StreamEvent } from "../packages/zcode-tui/src/events.ts";
import type { RuntimeBackgroundJob } from "../packages/zcode-tui/src/runtime-projection.ts";
import { TurnWorkTracker } from "../packages/zcode-tui/src/turn-work-tracker.ts";

function event(value: Partial<StreamEvent>): StreamEvent {
  return { raw: {}, ...value };
}

function job(
  taskId: string,
  status: RuntimeBackgroundJob["status"],
  turnId = "turn-current"
): RuntimeBackgroundJob {
  return { taskId, taskKind: "local_agent", status, turnId };
}

describe("turn work tracker", () => {
  test("keeps timing until every associated background task settles", () => {
    const tracker = new TurnWorkTracker();
    tracker.begin();
    tracker.bindTurn("turn-current");
    tracker.handle(event({ type: "background_task_started", taskId: "task-a", turnId: "turn-current" }));
    tracker.handle(event({ type: "background_task_started", taskId: "task-b", turnId: "turn-current" }));

    expect(tracker.finishForeground(true)).toBeTrue();
    expect(tracker.reconcile([job("task-a", "running"), job("task-b", "running")])).toBeTrue();
    expect(tracker.handle(event({
      type: "background_task_completed",
      taskId: "task-a",
      taskStatus: "failed"
    }))).toBeTrue();
    expect(tracker.handle(event({
      type: "background_task_completed",
      taskId: "task-b",
      taskStatus: "completed"
    }))).toBeFalse();
  });

  test("treats failure terminal statuses as settled and ignores older running jobs", () => {
    for (const status of ["failed", "timed_out", "cancelled", "spawn_error", "lost"] as const) {
      const tracker = new TurnWorkTracker();
      tracker.begin();
      tracker.bindTurn("turn-current");
      tracker.handle(event({ type: "subagent_spawned", agentId: "agent-1" }));
      tracker.finishForeground(true);

      expect(tracker.reconcile([
        job("agent-1", status),
        job("older-task", "running", "turn-older")
      ])).toBeFalse();
    }
  });

  test("waits for the post-foreground projection before settling an inline-only turn", () => {
    const tracker = new TurnWorkTracker();
    tracker.begin();
    tracker.bindTurn("turn-current");

    expect(tracker.finishForeground(true)).toBeTrue();
    expect(tracker.reconcile([])).toBeFalse();
  });

  test("resets task ownership when a newer foreground turn begins", () => {
    const tracker = new TurnWorkTracker();
    tracker.begin();
    tracker.bindTurn("turn-old");
    tracker.handle(event({ type: "background_task_started", taskId: "old-task", turnId: "turn-old" }));
    tracker.finishForeground(true);

    tracker.begin();
    tracker.bindTurn("turn-current");
    expect(tracker.reconcile([job("old-task", "running", "turn-old")])).toBeTrue();
    expect(tracker.finishForeground(true)).toBeTrue();
    expect(tracker.reconcile([job("old-task", "running", "turn-old")])).toBeFalse();
  });
});
