#!/usr/bin/env bun

import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import { createScenarioRuntime } from "../runtime/scenario-runtime.ts";

function decisionSummary(value: unknown): string {
  if (typeof value !== "object" || value === null) return "unknown";
  const record = value as Record<string, unknown>;
  return `${String(record.decision ?? "unknown")} · ${String(record.reason ?? "no reason")}`;
}

const runtime = createScenarioRuntime({
  journalPath: process.env.ZCODE_TUI_SCENARIO_RUNTIME_JOURNAL,
  unmatchedResponse: "Type “trigger permissions” to start.",
  turns: [{
    id: "concurrent-permissions",
    match: "trigger permissions",
    steps: [{
      type: "permissions",
      mode: "parallel",
      saveAs: "permissions",
      requests: [{
        toolCallId: "scenario_write",
        toolName: "Write",
        reason: "FIRST_WRITE_PERMISSION",
        input: { file_path: "output.txt", content: "first" }
      }, {
        toolCallId: "scenario_bash",
        toolName: "Bash",
        reason: "SECOND_BASH_PERMISSION",
        input: { command: "printf second" }
      }]
    }, {
      type: "respond",
      response: (context) => {
        const [firstDecision, secondDecision] = context.value<unknown[]>("permissions");
        return `Permission queue complete: ${decisionSummary(firstDecision)} | ${decisionSummary(secondDecision)}`;
      }
    }]
  }]
});

await runTui({
  version: "permission-queue-scenario",
  workspaceDirectory: process.cwd(),
  initialMode: "build",
  initialModel: "scenario/model",
  modelOptions: [{ alias: "main", id: "scenario/model", name: "Scenario" }],
  loadSessionTranscript: async () => [
    {
      messageId: "scenario_instruction",
      role: "agent",
      content: "Type “trigger permissions” to start the concurrent permission scenario."
    }
  ],
  submitPrompt: runtime.submitPrompt,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
} as Parameters<typeof runTui>[0]);
