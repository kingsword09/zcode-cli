#!/usr/bin/env bun

import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import type { PromptCallOptions } from "../../../packages/zcode-tui/src/types.ts";

function decisionSummary(value: unknown): string {
  if (typeof value !== "object" || value === null) return "unknown";
  const record = value as Record<string, unknown>;
  return `${String(record.decision ?? "unknown")} · ${String(record.reason ?? "no reason")}`;
}

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
  submitPrompt: async (input: unknown, options: PromptCallOptions) => {
    if (String(input) !== "trigger permissions") {
      return { response: "Type “trigger permissions” to start." };
    }
    if (!options.requestPermission) throw new Error("Permission callback is unavailable.");
    const first = options.requestPermission({
      toolCallId: "scenario_write",
      toolName: "Write",
      reason: "FIRST_WRITE_PERMISSION",
      input: { file_path: "output.txt", content: "first" }
    }, { abortSignal: options.abortSignal });
    const second = options.requestPermission({
      toolCallId: "scenario_bash",
      toolName: "Bash",
      reason: "SECOND_BASH_PERMISSION",
      input: { command: "printf second" }
    }, { abortSignal: options.abortSignal });
    const [firstDecision, secondDecision] = await Promise.all([first, second]);
    return {
      response: `Permission queue complete: ${decisionSummary(firstDecision)} | ${decisionSummary(secondDecision)}`
    };
  },
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
} as Parameters<typeof runTui>[0]);
