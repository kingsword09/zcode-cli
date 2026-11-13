import { runTui } from "../../../packages/zcode-tui/src/index.ts";

const showReasoning = process.env.ZCODE_TEST_SHOW_REASONING !== "false";

await runTui({
  showReasoning,
  workspaceDirectory: process.cwd(),
  loadSessionTranscript: async () => [{
    role: "assistant",
    parts: [
      { type: "thought", partId: "restored-thought", text: "RESTORED_THOUGHT_SENTINEL" },
      { type: "text", partId: "restored-answer", text: "THINKING_VISIBILITY_READY" }
    ]
  }],
  submitPrompt: async (input, options) => {
    await options.onEvent?.({
      kind: "reasoning_delta",
      messageId: "live-message",
      delta: "LIVE_THOUGHT_SENTINEL"
    });
    await Bun.sleep(1_000);
    return { response: String(input) };
  }
});
