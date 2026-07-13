#!/usr/bin/env bun

import { runTui } from "../../packages/zcode-tui/src/index.ts";
import type { PromptCallOptions } from "../../packages/zcode-tui/src/types.ts";

let model = "alpha/model";
let effort = "low";
let goal = {
  status: "active",
  tokenBudget: 50_000,
  tokensUsed: 40_000,
  timeUsedSeconds: 120
};

const assistantResponse = [
  "Feature prompt complete.",
  "",
  "```mermaid",
  "graph TD",
  "Input[用户输入] --> Editor[编辑器面板]",
  "```"
].join("\n");

const workflowPanel = (status = "running") => ({
  title: "/workflows",
  selectedRunId: "run_feature",
  updatedAt: "2026-07-13T10:00:00Z",
  runs: [{
    runId: "run_feature",
    status,
    task: "Feature workflow",
    kind: "script",
    updatedAt: "2026-07-13T10:00:00Z"
  }],
  detail: {
    snapshot: {
      runId: "run_feature",
      status,
      task: "Feature workflow",
      kind: "script",
      updatedAt: "2026-07-13T10:00:00Z"
    },
    scheduler: { active: status === "running" ? 1 : 0, completed: status === "running" ? 0 : 1, total: 1 },
    events: [{ timestamp: "2026-07-13T10:00:00Z", type: "phase.started", status }]
  }
});

async function emit(options: PromptCallOptions, event: unknown): Promise<void> {
  await options.onEvent?.({ type: "model.streaming", payload: event });
}

await runTui({
  version: "feature-smoke",
  workspaceDirectory: process.cwd(),
  initialMode: "build",
  initialModel: model,
  initialThoughtLevel: effort,
  modelOptions: [
    { alias: "main", id: "alpha/model", name: "Alpha" },
    { alias: "lite", id: "beta/model", name: "Beta" }
  ],
  effortOptions: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" }
  ],
  slashCommands: [
    { name: "model", description: "Select model" },
    { name: "effort", description: "Select effort" },
    { name: "mcp", description: "Manage MCP" },
    { name: "workflows", description: "Manage workflows" },
    { name: "goal", description: "Manage the session goal" }
  ],
  readClipboardImage: async () => ({
    dataUrl: "data:image/png;base64,aGVsbG8=",
    mediaType: "image/png",
    sizeBytes: 5
  }),
  listMcpServers: async () => ({
    docs: { status: "disconnected", transport: "stdio", toolCount: 2 }
  }),
  refreshWorkflowPanel: async () => workflowPanel(),
  stopWorkflow: async () => workflowPanel("cancelled"),
  readGoal: async () => goal,
  readSessionUsage: async () => ({
    totalTokens: 18_500,
    inputTokens: 14_000,
    outputTokens: 4_000,
    reasoningTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 9_000,
    modelRequestCount: 3,
    modelErrorCount: 0
  }),
  sendInput: async (input, options) => {
    const prompt = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
    const attachments = Array.isArray(prompt.attachments) ? prompt.attachments : [];
    const image = attachments[0] as Record<string, unknown> | undefined;
    if (prompt.text !== "inspect" || image?.type !== "image" || typeof image.content !== "string") {
      throw new Error("Feature smoke prompt did not include the clipboard image attachment.");
    }
    await emit(options, { kind: "tool_input_start", toolCallId: "call_read", toolName: "Read" });
    await emit(options, { kind: "tool_input_delta", toolCallId: "call_read", delta: '{"file_path":"demo.ts"}' });
    await emit(options, {
      kind: "tool_call",
      toolCallId: "call_read",
      toolName: "Read",
      input: { file_path: "demo.ts" }
    });
    await emit(options, {
      kind: "result",
      toolCallId: "call_read",
      toolName: "Read",
      result: { success: true, output: "source text" }
    });
    await emit(options, { kind: "text_delta", delta: assistantResponse });
    await Bun.sleep(1_100);
    return {
      kind: "started_turn",
      result: {
        response: assistantResponse,
        model,
        thoughtLevel: effort,
        projection: {
          contextUsed: 32_000,
          contextWindow: 128_000,
          totalTokenCount: 18_400,
          turnCount: 4
        }
      }
    };
  },
  submitPrompt: async (input) => {
    if (typeof input !== "string") return { response: "Unexpected structured slash command." };
    if (input === "/help") {
      return {
        response: [
          "Slash commands:",
          ...Array.from({ length: 36 }, (_, index) => `- /fixture-${index + 1}: Feature command ${index + 1}.`),
          "",
          "Use /help <command> for details."
        ].join("\n"),
        model,
        thoughtLevel: effort
      };
    }
    if (input.startsWith("/model ")) {
      model = input.slice("/model ".length);
      return {
        response: `Model switched to ${model}.`,
        model,
        thoughtLevel: effort,
        effortOptions: [{ id: "low", label: "Low" }, { id: "high", label: "High" }]
      };
    }
    if (input.startsWith("/effort ")) {
      effort = input.slice("/effort ".length);
      return { response: `Reasoning effort switched to ${effort}.`, model, thoughtLevel: effort };
    }
    if (input === "/mcp connect docs") return { response: "MCP connected: docs." };
    if (input === "/workflows") return { response: "", workflowPanel: workflowPanel() };
    if (input === "/goal pause") {
      goal = { ...goal, status: "paused" };
      return { response: "Goal paused.", model, thoughtLevel: effort };
    }
    return { response: `Handled ${input}.`, model, thoughtLevel: effort };
  },
  setMode: async (nextMode) => ({ mode: nextMode })
});
