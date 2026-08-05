import { describe, expect, test } from "bun:test";

import {
  InputQueue,
  type CommittedSteer,
  type InputQueueState,
  type QueuedSubmission
} from "../packages/zcode-tui/src/input-queue.ts";
import type { StreamEvent } from "../packages/zcode-tui/src/events.ts";

function submission(input: string): QueuedSubmission {
  return {
    displayInput: input,
    input,
    recordHistory: true,
    secrets: []
  };
}

function event(value: Omit<StreamEvent, "raw">): StreamEvent {
  return { ...value, raw: {} };
}

function queueHarness() {
  const states: InputQueueState[] = [];
  const committed: CommittedSteer[][] = [];
  const discarded: Array<{ count: number; reason?: string }> = [];
  const queue = new InputQueue({
    onStateChanged: (state) => states.push(state),
    onSteerCommitted: (entries) => committed.push(entries),
    onSteerDiscarded: (count, reason) => discarded.push({ count, reason })
  });
  return { committed, discarded, queue, states };
}

describe("TUI input queue", () => {
  test("publishes every editable follow-up transition", () => {
    const { queue, states } = queueHarness();

    queue.queueFollowUp(submission("first"));
    queue.queueFollowUp(submission("second"));
    expect(states.at(-1)).toEqual({ pendingSteers: [], queuedInputs: ["first", "second"] });
    expect(queue.hasFollowUps()).toBeTrue();

    expect(queue.editLatestFollowUp()?.input).toBe("second");
    expect(states.at(-1)?.queuedInputs).toEqual(["first"]);
    expect(queue.takeNextFollowUp()?.input).toBe("first");
    expect(states.at(-1)).toEqual({ pendingSteers: [], queuedInputs: [] });
    expect(queue.hasFollowUps()).toBeFalse();
  });

  test("tracks, associates and commits active-turn steers", () => {
    const { committed, queue, states } = queueHarness();

    queue.trackSteer(submission("Keep it concise."), "input_1");
    expect(states.at(-1)?.pendingSteers).toEqual(["Keep it concise."]);
    expect(queue.handleLifecycleEvent(event({
      type: "turn_steer_queued",
      inputId: "input_1",
      pendingInputId: "pending_1"
    }))).toBeTrue();
    expect(queue.handleLifecycleEvent(event({
      type: "turn_steer_drained",
      pendingInputIds: ["pending_1"],
      injectedMessageIds: ["message_1"]
    }))).toBeTrue();

    expect(committed).toEqual([[
      { displayInput: "Keep it concise.", messageId: "message_1" }
    ]]);
    expect(states.at(-1)).toEqual({ pendingSteers: [], queuedInputs: [] });
    expect(queue.hasPendingSteers()).toBeFalse();
  });

  test("returns discarded steers to the editable next-turn queue", () => {
    const { discarded, queue, states } = queueHarness();

    queue.trackSteer(submission("Try this next."), "input_2");
    queue.associateSteer("input_2", "pending_2");
    expect(queue.handleLifecycleEvent(event({
      type: "turn.steerDiscarded",
      pendingInputIds: ["pending_2"],
      reason: "turn_ended"
    }))).toBeTrue();

    expect(discarded).toEqual([{ count: 1, reason: "turn_ended" }]);
    expect(states.at(-1)).toEqual({ pendingSteers: [], queuedInputs: ["Try this next."] });
    expect(queue.takeNextFollowUp()).toMatchObject({
      input: "Try this next.",
      recordHistory: false
    });
  });

  test("settles a drained steer when the terminal event precedes its queued event", () => {
    const { committed, queue, states } = queueHarness();

    queue.trackSteer(submission("Apply the queued correction."), "input_early", "turn_early");
    queue.handleLifecycleEvent(event({
      type: "turn_steer_drained",
      pendingInputIds: ["pending_early"],
      injectedMessageIds: ["message_early"],
      targetTurnId: "turn_early"
    }));

    expect(queue.hasPendingSteers()).toBeTrue();
    queue.handleLifecycleEvent(event({
      type: "turn_steer_queued",
      inputId: "input_early",
      pendingInputId: "pending_early",
      targetTurnId: "turn_early"
    }));

    expect(committed).toEqual([[
      { displayInput: "Apply the queued correction.", messageId: "message_early" }
    ]]);
    expect(states.at(-1)).toEqual({ pendingSteers: [], queuedInputs: [] });
  });

  test("returns a discarded steer when the terminal event precedes its queued event", () => {
    const { discarded, queue, states } = queueHarness();

    queue.trackSteer(submission("Keep this for the next turn."), "input_early_discard", "turn_early");
    queue.handleLifecycleEvent(event({
      type: "turn.steerDiscarded",
      pendingInputIds: ["pending_early_discard"],
      reason: "turn_ended",
      targetTurnId: "turn_early"
    }));
    queue.handleLifecycleEvent(event({
      type: "turn.steerQueued",
      inputId: "input_early_discard",
      pendingInputId: "pending_early_discard",
      targetTurnId: "turn_early"
    }));

    expect(discarded).toEqual([{ count: 1, reason: "turn_ended" }]);
    expect(states.at(-1)).toEqual({
      pendingSteers: [],
      queuedInputs: ["Keep this for the next turn."]
    });
  });

  test("requeues unresolved steers at turn end and ignores late old-turn events", () => {
    const { discarded, committed, queue, states } = queueHarness();

    queue.trackSteer(submission("Do not lose this input."), "input_requeue", "turn_old");
    queue.associateSteer("input_requeue", "pending_requeue", "turn_old");
    expect(queue.requeuePendingSteers("turn_ended", "turn_old")).toBe(1);
    expect(discarded).toEqual([{ count: 1, reason: "turn_ended" }]);
    expect(queue.hasPendingSteers()).toBeFalse();
    expect(states.at(-1)).toEqual({
      pendingSteers: [],
      queuedInputs: ["Do not lose this input."]
    });
    expect(queue.takeNextFollowUp()).toMatchObject({
      input: "Do not lose this input.",
      pendingInputIds: ["pending_requeue"],
      recordHistory: false
    });

    queue.trackSteer(submission("New turn input."), "input_new", "turn_new");
    queue.associateSteer("input_new", "pending_new", "turn_new");
    queue.handleLifecycleEvent(event({
      type: "turn_steer_drained",
      pendingInputIds: ["pending_requeue"],
      injectedMessageIds: ["message_late"],
      targetTurnId: "turn_old"
    }));

    expect(committed).toEqual([]);
    expect(states.at(-1)?.pendingSteers).toEqual(["New turn input."]);
  });

  test("merges every pending steer ahead of drafts for immediate Esc submission", () => {
    const { discarded, queue, states } = queueHarness();

    queue.queueFollowUp(submission("Keep this draft queued."));
    queue.trackSteer(submission("First correction."), "input_first", "turn_merge", "pending_first");
    queue.associateSteer("input_first", "pending_first", "turn_merge");
    queue.trackSteer(submission("Second correction."), "input_second", "turn_merge", "pending_second");
    queue.associateSteer("input_second", "pending_second", "turn_merge");

    expect(queue.admittedPendingInputIds()).toEqual(["pending_first", "pending_second"]);
    expect(queue.requeuePendingSteers(
      "turn_cancelled",
      "turn_merge",
      true,
      "steer_interrupt_reservation"
    )).toBe(2);
    expect(discarded).toEqual([]);
    expect(states.at(-1)).toEqual({
      pendingSteers: [],
      queuedInputs: ["First correction.\nSecond correction.", "Keep this draft queued."]
    });
    expect(queue.takeNextFollowUp()).toMatchObject({
      displayInput: "First correction.\nSecond correction.",
      input: "First correction.\nSecond correction.",
      pendingInputReservationId: "steer_interrupt_reservation",
      pendingInputIds: ["pending_first", "pending_second"],
      recordHistory: false
    });
    expect(queue.takeNextFollowUp()?.input).toBe("Keep this draft queued.");
  });

  test("does not bind a pending steer to a different turn", () => {
    const { committed, queue } = queueHarness();

    queue.trackSteer(submission("Current turn only."), "input_current", "turn_current");
    queue.handleLifecycleEvent(event({
      type: "turn_steer_queued",
      inputId: "input_current",
      pendingInputId: "pending_stale",
      targetTurnId: "turn_stale"
    }));
    queue.handleLifecycleEvent(event({
      type: "turn_steer_drained",
      pendingInputIds: ["pending_stale"],
      injectedMessageIds: ["message_stale"],
      targetTurnId: "turn_stale"
    }));

    expect(committed).toEqual([]);
    expect(queue.hasPendingSteers()).toBeTrue();

    queue.handleLifecycleEvent(event({
      type: "turn_steer_queued",
      inputId: "input_current",
      pendingInputId: "pending_current",
      targetTurnId: "turn_current"
    }));
    queue.handleLifecycleEvent(event({
      type: "turn_steer_drained",
      pendingInputIds: ["pending_current"],
      injectedMessageIds: ["message_current"],
      targetTurnId: "turn_current"
    }));

    expect(committed).toEqual([[
      { displayInput: "Current turn only.", messageId: "message_current" }
    ]]);
  });

  test("records a completed turn even after all steers were already settled", () => {
    const { committed, queue } = queueHarness();

    queue.trackSteer(submission("Already consumed."), "input_done", "turn_done");
    queue.associateSteer("input_done", "pending_done", "turn_done");
    queue.handleLifecycleEvent(event({
      type: "turn_steer_drained",
      pendingInputIds: ["pending_done"],
      injectedMessageIds: ["message_done"],
      targetTurnId: "turn_done"
    }));
    expect(queue.requeuePendingSteers("turn_ended", "turn_done")).toBe(0);

    queue.trackSteer(submission("Next turn."), "input_next", "turn_next");
    queue.associateSteer("input_next", "pending_next", "turn_next");
    queue.handleLifecycleEvent(event({
      type: "turn_steer_drained",
      pendingInputIds: ["pending_done"],
      injectedMessageIds: ["message_duplicate"],
      targetTurnId: "turn_done"
    }));

    expect(committed).toEqual([[
      { displayInput: "Already consumed.", messageId: "message_done" }
    ]]);
    expect(queue.hasPendingSteers()).toBeTrue();
    expect(queue.handleLifecycleEvent(event({
      type: "tool_call_started",
      targetTurnId: "turn_done"
    }))).toBeFalse();
  });

  test("keeps auto-send control and unrelated events explicit", () => {
    const { queue, states } = queueHarness();

    queue.autoSend = false;
    expect(queue.autoSend).toBeFalse();
    queue.resetAutoSend();
    expect(queue.autoSend).toBeTrue();
    expect(queue.handleLifecycleEvent(event({ type: "tool_call_started" }))).toBeFalse();
    expect(states).toEqual([]);
  });
});
