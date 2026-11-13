import { runTui } from "../../../packages/zcode-tui/src/index.ts";

const showReasoning = process.env.ZCODE_TEST_SHOW_REASONING !== "false";

await runTui({
  showReasoning,
  workspaceDirectory: process.cwd(),
  loadSessionTranscript: async () => [
    { role: "user", messageId: "user-turn-1", parts: [{ type: "text", text: "first turn" }] },
    {
      role: "assistant",
      messageId: "assistant-turn-1a",
      parts: [
        { type: "thought", partId: "restored-thought-1", text: "RESTORED_FIRST_THOUGHT_SENTINEL" },
        { type: "thought", partId: "restored-thought-2", text: "RESTORED_SECOND_THOUGHT_SENTINEL" },
        { type: "text", partId: "restored-answer", text: "THINKING_VISIBILITY_READY" }
      ]
    },
    {
      role: "assistant",
      messageId: "assistant-turn-1b",
      parts: [{ type: "thought", partId: "restored-thought-3", text: "RESTORED_LATER_MESSAGE_THOUGHT_SENTINEL" }]
    },
    { role: "user", messageId: "user-turn-2", parts: [{ type: "text", text: "second turn" }] },
    {
      role: "assistant",
      messageId: "assistant-turn-2",
      parts: [{ type: "thought", partId: "restored-thought-4", text: "RESTORED_NEXT_TURN_FIRST_THOUGHT_SENTINEL" }]
    }
  ],
  submitPrompt: async (input, options) => {
    const turnLabel = String(input).includes("second")
      ? "SECOND_TURN"
      : String(input).includes("visible") ? "VISIBLE_TURN" : "FIRST_TURN";
    await options.onEvent?.({
      kind: "reasoning_delta",
      messageId: "live-message",
      delta: `LIVE_FIRST_THOUGHT_${turnLabel}_SENTINEL`
    });
    await options.onEvent?.({
      kind: "reasoning_delta",
      messageId: "live-message-later",
      delta: `LIVE_SECOND_THOUGHT_${turnLabel}_SENTINEL`
    });
    await Bun.sleep(1_000);
    return { response: `TURN_FINISHED:${String(input)}` };
  }
});
