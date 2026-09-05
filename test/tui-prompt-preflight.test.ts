import { describe, expect, test } from "bun:test";

import { InputQueue, type InputQueueState, type QueuedSubmission } from "../packages/zcode-tui/src/input-queue.ts";
import { preflightSubmission } from "../packages/zcode-tui/src/prompt-preflight.ts";

function fixture(queued = false) {
  const states: InputQueueState[] = [];
  const warnings: string[] = [];
  const inputQueue = new InputQueue({
    onStateChanged: state => states.push(state),
    onSteerCommitted() {}, onSteerDiscarded() {}
  });
  const submission: QueuedSubmission = {
    input: "original prompt", displayInput: "original prompt", secrets: [],
    recordHistory: !queued,
    ...(queued ? { pendingInputIds: ["pending_1"], pendingInputReservationId: "reservation_1" } : {})
  };
  const state = { draft: "", stopped: false };
  let finish!: (diagnostic: string | undefined) => void;
  const validation = new Promise<string | undefined>(resolve => { finish = resolve; });
  const options = {
    validate: () => validation,
    isStopped: () => state.stopped,
    submission, queued, inputQueue,
    editor: { getText: () => state.draft, setText: (text: string) => { state.draft = text; } },
    warn: (message: string) => { warnings.push(message); }
  };
  return { options, state, finish, states, warnings };
}

describe("TUI prompt preflight input preservation", () => {
  test("restores a popped follow-up at the front with metadata and auto-send paused", async () => {
    const f = fixture(true);
    const { inputQueue, submission } = f.options;
    const second = { ...submission, input: "second", displayInput: "second" };
    inputQueue.queueFollowUp(submission);
    inputQueue.queueFollowUp(second);
    expect(inputQueue.takeNextFollowUp()).toBe(submission);
    const pending = preflightSubmission(f.options);
    f.finish("missing key");
    expect(await pending).toBeFalse();
    expect(inputQueue.autoSend).toBeFalse();
    expect(f.states.at(-1)?.queuedInputs).toEqual(["original prompt", "second"]);
    expect(inputQueue.takeNextFollowUp()).toBe(submission);
    expect(inputQueue.takeNextFollowUp()).toBe(second);
    expect(inputQueue.hasFollowUps()).toBeFalse();
    expect(f.state.draft).toBe("");
  });

  test("retains both a rejected prompt and a newer draft typed during validation", async () => {
    const f = fixture();
    const pending = preflightSubmission(f.options);
    f.state.draft = "newer draft";
    f.finish("missing key");
    expect(await pending).toBeFalse();
    expect(f.state.draft).toBe("newer draft");
    expect(f.options.inputQueue.takeNextFollowUp()).toBe(f.options.submission);
    expect(f.options.inputQueue.autoSend).toBeFalse();
    expect(f.warnings).toEqual(["missing key"]);
  });

  test("restores direct input to an empty editor without duplicating it in the queue", async () => {
    const f = fixture();
    const pending = preflightSubmission(f.options);
    f.finish("missing key");
    expect(await pending).toBeFalse();
    expect(f.state.draft).toBe("original prompt");
    expect(f.options.inputQueue.hasFollowUps()).toBeFalse();
    expect(f.options.inputQueue.autoSend).toBeFalse();
  });

  test("allows configured access without changing drafts or queue state", async () => {
    const f = fixture();
    const pending = preflightSubmission(f.options);
    f.state.draft = "next prompt";
    f.finish(undefined);
    expect(await pending).toBeTrue();
    expect(f.state.draft).toBe("next prompt");
    expect(f.options.inputQueue.autoSend).toBeTrue();
    expect(f.states).toEqual([]);
    expect(f.warnings).toEqual([]);
  });

  for (const diagnostic of [undefined, "missing key"]) {
    test(`does not submit or update a stopped TUI after validation (${diagnostic ?? "allowed"})`, async () => {
      const f = fixture();
      const pending = preflightSubmission(f.options);
      f.state.stopped = true;
      f.finish(diagnostic);
      expect(await pending).toBeFalse();
      expect(f.state.draft).toBe("");
      expect(f.states).toEqual([]);
      expect(f.warnings).toEqual([]);
    });
  }
});
