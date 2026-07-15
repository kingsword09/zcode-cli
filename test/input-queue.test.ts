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
