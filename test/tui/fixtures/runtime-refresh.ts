import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import { ScenarioRuntimeJournal } from "../runtime/scenario-runtime.ts";

const journal = new ScenarioRuntimeJournal(process.env.ZCODE_TUI_SCENARIO_RUNTIME_JOURNAL);
let sessionId = "first-session";
let contextReads = 0;
let projectionReads = 0;
let completed = false;
let listener: ((event: unknown) => void | Promise<void>) | undefined;

await runTui({
  initialModel: "scenario/model",
  workspaceDirectory: process.cwd(),
  subscribeSessionEvents: (sink) => { listener = sink; return () => { listener = undefined; }; },
  readRuntimeProjection: async () => {
    projectionReads++;
    return {
      sessionId, status: "idle", totalTokenCount: completed ? 200 : 100,
      contextUsage: { used: 100, size: 1_000 }, activeToolCalls: [], backgroundJobs: []
    };
  },
  loadSessionContextMessages: async () => {
    contextReads++;
    journal.record("context.read", { sessionId, contextReads });
    return [{ info: { id: "assistant", role: "assistant", tokens: {
      input: 100, cache: { read: sessionId === "second-session" ? 20 : completed ? 60 : 80, write: 0 }
    } }, parts: [] }];
  },
  submitPrompt: async (input, options) => {
    if (String(input) === "/resume second") {
      sessionId = "second-session";
      return { response: "Resumed second session", resetSessionProjection: true, restoredMessages: [] };
    }
    const before = contextReads;
    const projectionsBefore = projectionReads;
    const startedAt = performance.now();
    for (let index = 0; index < 40; index++) {
      const event = { id: `text-${index}`, sessionId, type: "model_streaming",
        payload: { kind: "text_delta", delta: "x", assistantMessageId: "streamed-message" } };
      await options.onEvent?.(event);
      await listener?.(event);
      await Bun.sleep(20);
    }
    await Bun.sleep(120);
    journal.record("text-deltas.finished", {
      before, after: contextReads, projectionReads: projectionReads - projectionsBefore,
      elapsedMs: performance.now() - startedAt
    });
    for (let index = 0; index < 10; index++) {
      await listener?.({ id: `progress-${index}`, sessionId, type: "tool_call_progress",
        payload: { toolCallId: "tool", toolName: "Bash", elapsedMs: index * 100 } });
      await Bun.sleep(100);
    }
    journal.record("tool-progress.finished", { before, after: contextReads });
    completed = true;
    await listener?.({ id: "complete", sessionId, type: "model_complete", payload: {} });
    return { response: "Streaming completed" };
  }
});
