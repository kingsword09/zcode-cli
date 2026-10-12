#!/usr/bin/env bun

import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import type { PromptCallOptions } from "../../../packages/zcode-tui/src/types.ts";

let requestCount = 0;

async function submitPrompt(input: unknown, options: PromptCallOptions): Promise<unknown> {
  if (input !== "request guarded permission") return { response: "Type request guarded permission to start." };
  const attempt = ++requestCount;
  const result = await options.requestPermission!({
    toolName: "Bash",
    input: { command: "rm -rf build" },
    reason: "GUARDED_SINGLE_USE_PERMISSION",
    mode: "guarded",
    approvalMode: "user-once",
    options: [{
      optionId: "allow_project",
      kind: "allow_always",
      name: "Always allow in this project",
      response: { decision: "allow", permissionUpdates: [{ type: "addRules" }] }
    }]
  });
  return { response: `Guarded result ${attempt}: ${JSON.stringify(result)}` };
}

await runTui({
  workspaceDirectory: process.cwd(),
  initialMode: "guarded",
  loadSessionTranscript: async () => [{
    messageId: "instructions",
    role: "agent",
    content: "Type request guarded permission to start."
  }],
  submitPrompt
});
