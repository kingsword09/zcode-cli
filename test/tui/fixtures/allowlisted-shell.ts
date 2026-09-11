#!/usr/bin/env bun

import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import {
  createScenarioRuntime,
  ScenarioRuntimeJournal
} from "../runtime/scenario-runtime.ts";
import { createScenarioShell } from "../runtime/scenario-shell.ts";

function permissionAllowed(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>).decision === "allow";
}

const journal = new ScenarioRuntimeJournal(
  process.env.ZCODE_TUI_SCENARIO_RUNTIME_JOURNAL
);
const shell = createScenarioShell({
  journal,
  workspaceDirectory: process.cwd()
});
const command = "mkdir -p reports && printf 'alpha\\nbeta\\n' | tee reports/shell.txt | wc -l";
const runtime = createScenarioRuntime({
  journal,
  unmatchedResponse: "Type “run allowlisted shell” to start.",
  turns: [{
    id: "run-allowlisted-shell",
    match: "run allowlisted shell",
    steps: [{
      type: "permissions",
      requests: [{
        toolCallId: "scenario_allowlisted_shell",
        toolName: "Bash",
        reason: "ALLOWLISTED_SHELL_WRITE",
        input: { command }
      }],
      saveAs: "permissions"
    }, {
      type: "respond",
      response: async (context) => {
        const [decision] = context.value<unknown[]>("permissions");
        if (!permissionAllowed(decision)) return "Allowlisted shell cancelled.";
        const result = await shell.exec(command, {
          signal: context.options.abortSignal
        });
        return `Allowlisted shell complete: ${result.stdout.trim()} lines.`;
      }
    }]
  }]
});

await runTui({
  version: "allowlisted-shell-scenario",
  workspaceDirectory: process.cwd(),
  initialMode: "build",
  initialModel: "scenario/model",
  modelOptions: [{ alias: "main", id: "scenario/model", name: "Scenario" }],
  loadSessionTranscript: async () => [
    {
      messageId: "scenario_instruction",
      role: "agent",
      content: "Type “run allowlisted shell” to execute a bounded just-bash command."
    }
  ],
  submitPrompt: runtime.submitPrompt,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
} as Parameters<typeof runTui>[0]);
