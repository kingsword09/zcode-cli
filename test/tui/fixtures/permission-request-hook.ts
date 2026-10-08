#!/usr/bin/env bun

import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import type { PromptCallOptions } from "../../../packages/zcode-tui/src/types.ts";

async function submitPrompt(input: unknown, options: PromptCallOptions): Promise<unknown> {
  if (input === "next prompt") return { response: "Follow-up received." };
  if (input !== "hook allow" && input !== "hook deny") {
    return { response: "Type “hook allow” or “hook deny” to start." };
  }
  const allowed = input === "hook allow";
  const firstTool = { toolCallId: "first", toolName: "Bash", input: { command: "printf FIRST_TOOL" } };
  const hookTool = { toolCallId: "hook", toolName: "Bash", input: { command: "printf HOOK_TOOL" } };
  for (const tool of [firstTool, hookTool]) {
    await options.onEvent?.({ type: "tool_call_scheduled", ...tool });
  }
  const hookController = new AbortController();
  const first = options.requestPermission!({
    ...firstTool,
    reason: "FIRST_ACTIVE_PERMISSION"
  }, { signal: options.abortSignal });
  const queued = options.requestPermission!({
    ...hookTool,
    reason: "HOOK_PERMISSION"
  }, { signal: hookController.signal });

  // Let the first dialog open, then settle the queued request as the runtime
  // does when a PermissionRequest hook wins the race against the client.
  await Promise.resolve();
  hookController.abort();
  if (allowed) await options.onEvent?.({ type: "tool_call_started", ...hookTool });
  await options.onEvent?.({
    type: "tool_call_result",
    ...hookTool,
    result: allowed
      ? { success: true, output: "HOOK_TOOL_SUCCEEDED" }
      : { success: false, error: { message: "Denied by permission hook" } }
  });
  await options.onEvent?.({ kind: "text_delta", delta: "HOOK_SETTLED_WHILE_QUEUED\n" });

  await first;
  await options.onEvent?.({ type: "tool_call_started", ...firstTool });
  await options.onEvent?.({ type: "tool_call_result", ...firstTool, result: { success: true, output: "FIRST_TOOL_SUCCEEDED" } });
  await queued;
  return { response: "Hook race complete." };
}

await runTui({
  version: "permission-hook-scenario",
  workspaceDirectory: process.cwd(),
  initialMode: "build",
  initialModel: "scenario/model",
  modelOptions: [{ alias: "main", id: "scenario/model", name: "Scenario" }],
  loadSessionTranscript: async () => [{
    messageId: "scenario_instruction",
    role: "agent",
    content: "Type “hook allow” or “hook deny” to start."
  }],
  submitPrompt,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
});
