#!/usr/bin/env bun

import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import { createScenarioRuntime } from "../runtime/scenario-runtime.ts";

const runtime = createScenarioRuntime({
  journalPath: process.env.ZCODE_TUI_SCENARIO_RUNTIME_JOURNAL,
  unmatchedResponse: "Type “modify workspace” to start.",
  workspaceDirectory: process.cwd(),
  turns: [{
    id: "modify-workspace",
    match: "modify workspace",
    steps: [{
      type: "writeFiles",
      files: {
        "src/example.ts": "export const value = 2;\n",
        "src/created.ts": "export const created = true;\n"
      }
    }, {
      type: "respond",
      response: "Workspace write complete."
    }]
  }]
});

await runTui({
  version: "write-and-diff-scenario",
  workspaceDirectory: process.cwd(),
  initialMode: "build",
  initialModel: "scenario/model",
  modelOptions: [{ alias: "main", id: "scenario/model", name: "Scenario" }],
  loadSessionTranscript: async () => [
    {
      messageId: "scenario_instruction",
      role: "agent",
      content: "Type “modify workspace” to start the isolated Write and real Git diff scenario."
    }
  ],
  submitPrompt: runtime.submitPrompt,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
} as Parameters<typeof runTui>[0]);
