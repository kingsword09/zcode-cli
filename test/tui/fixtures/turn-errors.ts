import { runTui } from "../../../packages/zcode-tui/src/index.ts";

await runTui({
  workspaceDirectory: process.cwd(),
  loadSessionTranscript: async () => [{ role: "assistant", content: "ERROR_FIXTURE_READY" }],
  submitPrompt: async (input, options) => {
    if (input === "wrapped") {
      throw new Error("Turn execution failed", { cause: Object.assign(new Error("Provider connection refused"), { code: "ECONNREFUSED" }) });
    }
    if (input === "recover") {
      await options.onEvent?.({ type: "model_request_failed", message: "Temporary network failure", retryable: true });
      await options.onEvent?.({ type: "model_request_completed" });
      throw new Error("Turn execution failed");
    }
    await options.onEvent?.({ type: "model_request_failed", payload: {
      type: "model_request_failed", message: "Provider quota exhausted", statusCode: 429,
      errorCode: "quota_exceeded", retryable: false
    } });
    await options.onEvent?.({ type: "turn_error", payload: { error: { message: "Turn execution failed" } } });
    throw new Error("Turn execution failed");
  }
});
