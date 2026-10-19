#!/usr/bin/env bun

import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import type { PromptCallOptions } from "../../../packages/zcode-tui/src/types.ts";

async function emit(options: PromptCallOptions, type: string, payload: unknown): Promise<void> {
  await options.onEvent?.({ type, payload });
  // Let the TUI render each status before the next one supersedes it.
  await Bun.sleep(200);
}

await runTui({
  initialModel: "scenario/model",
  workspaceDirectory: process.cwd(),
  loadSessionTranscript: async () => [{
    messageId: "model_status_instruction",
    role: "agent",
    content: "Type “recover stream” to recover a model request that failed after streaming output. Type “fail hard” to end a turn on an unrecoverable request."
  }],
  submitPrompt: async (input, options) => {
    if (String(input) === "fail hard") {
      await emit(options, "model.network_status", { type: "model_request_started", attempt: 1, maxAttempts: 6 });
      await emit(options, "model.network_status", {
        type: "model_request_failed",
        attempt: 1,
        maxAttempts: 6,
        message: "Provider rejected the request.",
        reason: "invalid_request",
        retryable: false
      });
      throw new Error("Provider rejected the request.");
    }
    await emit(options, "model.network_status", { type: "model_request_started", attempt: 1, maxAttempts: 6 });
    for (const [index, attempt] of [1, 2].entries()) {
      // The runtime reports a stalled stream, then a non-retryable failure once streamed
      // output is committed, and finally recovers that same request at the turn level.
      await emit(options, "model.network_status", {
        type: "model_stream_stalled",
        attempt,
        maxAttempts: 6,
        idleMs: 60_000,
        timeoutMs: 60_000,
        message: "Model stream stalled: no event received for 60000ms."
      });
      await emit(options, "model.network_status", {
        type: "model_request_failed",
        attempt,
        maxAttempts: 6,
        message: `Attempt ${attempt} lost the provider stream.`,
        reason: "network_error",
        retryable: false,
        streamOutputCommitted: true
      });
      await emit(options, "streamRecovery.updated", {
        attemptId: `attempt_${attempt}`,
        failureKind: "sse_disconnected",
        message: `Attempt ${attempt} lost the provider stream.`,
        retryNumber: index + 1,
        maxRetries: 5
      });
      await emit(options, "model.network_status", {
        type: "model_request_started",
        attempt: attempt + 1,
        maxAttempts: 6,
        streamRecovery: { retryNumber: index + 1, maxRetries: 5, message: "Model stream recovery retry started" }
      });
    }
    await emit(options, "model.network_status", { type: "model_request_completed", attempt: 3, maxAttempts: 6 });
    return { response: "Recovered after reconnecting the model stream." };
  }
});
