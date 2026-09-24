import { runTui } from "../../../packages/zcode-tui/src/index.ts";
let sink: ((event: unknown) => void | Promise<void>) | undefined;
let resumed = false;
const run = () => ({ runId: "run-1", label: "Review workspace", status: resumed ? "running" : "stopped",
  resumable: !resumed, nodes: [{ phase: "settled" }, { phase: resumed ? "settled" : "waiting" }],
  usage: { spentTokens: 321 }, actors: [{ name: "Reviewer", status: "waiting" }], artifacts: [{ title: "report.md" }] });
await runTui({
  initialModel: "scenario/model", workspaceDirectory: process.cwd(),
  getMainSessionId: () => "main-session",
  subscribeSessionEvents: (listener) => { sink = listener; return () => { sink = undefined; }; },
  listWorkflowRuns: async () => [run()],
  replayWorkflowRuns: async () => [{ runId: "run-1", sequence: resumed ? 2 : 1, eventType: "run-settled", payload: run() }],
  reduceWorkflowRuns: (_state, event) => ({ runs: [(event as { payload: unknown }).payload] }),
  submitPrompt: async (input) => {
    if (input === "/dwf resume run-1") {
      resumed = true;
      await sink?.({ type: "dynamic_workflow_run_progress", sessionId: "main-session",
        payload: { runId: "run-1", sequence: 2, eventType: "run-started", payload: run() } });
      return { response: "Resumed dynamic workflow run run-1." };
    }
    return { response: String(input) };
  }
});
