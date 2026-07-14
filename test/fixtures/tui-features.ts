#!/usr/bin/env bun

import { runTui } from "../../packages/zcode-tui/src/index.ts";
import type { PromptCallOptions } from "../../packages/zcode-tui/src/types.ts";

let model = "alpha/model";
let effort = "low";
let backgroundStatus = "running";
let turnCompleted = false;
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

const planTodos = [
  { content: "Map runtime events", status: "completed", priority: "high" },
  { content: "Render plan updates", status: "completed", priority: "high" },
  { content: "Verify the TUI", status: "in_progress", priority: "medium" }
];

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

async function emitRuntime(options: PromptCallOptions, type: string, payload: unknown): Promise<void> {
  await options.onEvent?.({ type, payload });
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
  loadSessionTranscript: async () => [
    { role: "user", content: "Restored startup prompt." },
    { role: "agent", content: "Restored startup response." }
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
  readTodos: async () => planTodos,
  readRuntimeProjection: async () => ({
    id: "feature-session",
    status: "idle",
    mode: "build",
    turnCount: 4,
    totalTokenCount: 18_500,
    contextUsed: 32_000,
    contextWindow: 128_000,
    contextUsage: {
      used: 32_000,
      size: 128_000,
      cache: { inputTokens: 12_000, cacheReadTokens: 9_000, cacheWriteTokens: 1_000, latestHitRate: 0.75 },
      breakdown: [
        { source: "system_prompt", chars: 12_000 },
        { source: "skills", chars: 4_000 },
        { source: "system_tool_schemas", chars: 8_000 },
        { source: "messages", chars: 40_000 }
      ]
    },
    activeToolCalls: [],
    backgroundTasks: [{
      taskId: "bg_feature",
      toolName: "Bash",
      description: turnCompleted ? "Feature background audit · turn complete" : "Feature background audit",
      command: "bun test",
      status: backgroundStatus,
      cancellable: true,
      pid: 4242,
      startedAt: Date.now() - 5_000,
      stdoutBytes: 512,
      stdoutTail: "Background audit running"
    }]
  }),
  cancelBackgroundTask: async (taskId) => {
    if (taskId !== "bg_feature") throw new Error(`Unexpected background task: ${taskId}`);
    backgroundStatus = "cancelled";
    return { cancelled: true, status: backgroundStatus, taskId };
  },
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
    await emit(options, { kind: "reasoning_delta", delta: "Inspecting " });
    await emit(options, { kind: "reasoning_delta", delta: "the repository before using tools." });
    await emit(options, { kind: "tool_input_start", toolCallId: "call_plan", toolName: "TodoWrite" });
    await emit(options, {
      kind: "tool_input_delta",
      toolCallId: "call_plan",
      delta: JSON.stringify({ todos: planTodos })
    });
    await emit(options, {
      kind: "tool_call",
      toolCallId: "call_plan",
      toolName: "TodoWrite",
      input: { todos: planTodos }
    });
    await emitRuntime(options, "tool_call_scheduled", {
      toolCallId: "call_plan",
      toolName: "TodoWrite",
      input: { todos: planTodos }
    });
    await emitRuntime(options, "tool_call_started", {
      toolCallId: "call_plan",
      toolName: "TodoWrite",
      startedAt: Date.now()
    });
    await emitRuntime(options, "tool_call_result", {
      toolCallId: "call_plan",
      result: { success: true, output: { todos: planTodos } }
    });
    await emitRuntime(options, "part.started", {
      part: {
        type: "text",
        partId: "part_commentary",
        messageId: "message_assistant",
        text: "I will inspect the repository first."
      }
    });
    const readPart = {
      type: "tool",
      partId: "part_read",
      messageId: "message_assistant",
      callId: "call_read",
      tool: "Read",
      state: { status: "running", input: { file_path: "demo.ts" } }
    };
    await emitRuntime(options, "part.started", { part: readPart });
    await emitRuntime(options, "part.upserted", {
      part: {
        ...readPart,
        state: { status: "completed", input: { file_path: "demo.ts" }, output: "source text" }
      }
    });
    const agentPart = {
      type: "tool",
      partId: "part_agent",
      messageId: "message_assistant",
      callId: "call_agent",
      tool: "Agent",
      state: {
        status: "running",
        input: { agentType: "explore", description: "Inspect nested rendering", prompt: "Read child.ts" }
      }
    };
    await emitRuntime(options, "part.started", { part: agentPart });
    await emitRuntime(options, "subagent_spawned", {
      parentToolCallId: "call_agent",
      agentId: "agent_feature",
      agentType: "explore",
      childSessionId: "session_feature_child",
      description: "Inspect nested rendering"
    });
    const childPart = {
      type: "tool",
      partId: "part_child_bash",
      messageId: "message_assistant",
      callId: "call_child_bash",
      tool: "Bash",
      state: {
        status: "running",
        input: { command: "sed -n '1,80p' child.ts" },
        metadata: { parentToolCallId: "call_agent" }
      }
    };
    await emitRuntime(options, "part.started", { part: childPart });
    await emitRuntime(options, "part.upserted", {
      part: {
        ...childPart,
        state: {
          ...childPart.state,
          status: "completed",
          output: "export const child = true;"
        }
      }
    });
    await emitRuntime(options, "subagent_stopped", {
      parentToolCallId: "call_agent",
      agentId: "agent_feature",
      agentType: "explore",
      childSessionId: "session_feature_child",
      totalToolUseCount: 1,
      totalTokens: 800,
      outputFile: "/tmp/agent-feature.output"
    });
    await emitRuntime(options, "part.upserted", {
      part: {
        ...agentPart,
        state: {
          ...agentPart.state,
          status: "completed",
          output: {
            status: "completed",
            agentId: "agent_feature",
            agentType: "explore",
            prompt: "Read child.ts",
            content: [{ type: "text", text: "Nested rendering inspected." }],
            totalToolUseCount: 1,
            totalDurationMs: 900,
            totalTokens: 800
          }
        }
      }
    });
    const editInput = {
      file_path: "demo.ts",
      old_string: "const value = 1;",
      new_string: "const value = 2;"
    };
    const editPart = {
      type: "tool",
      partId: "part_edit",
      messageId: "message_assistant",
      callId: "call_edit",
      tool: "Edit",
      state: { status: "running", input: editInput }
    };
    await emitRuntime(options, "part.started", { part: editPart });
    await emitRuntime(options, "part.upserted", {
      part: {
        ...editPart,
        state: {
          status: "completed",
          input: editInput,
          output: "Updated demo.ts",
          metadata: {
            display: {
          kind: "file_diff",
          filePath: "demo.ts",
          additions: 1,
          deletions: 1,
          structuredPatch: [{
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-const value = 1;", "+const value = 2;"]
          }]
            }
          }
        }
      }
    });
    await emit(options, { kind: "reasoning_delta", delta: "Synthesizing the final response." });
    await emitRuntime(options, "part.started", {
      part: {
        type: "text",
        partId: "part_final",
        messageId: "message_assistant",
        text: assistantResponse
      }
    });
    await Bun.sleep(1_100);
    turnCompleted = true;
    return {
      kind: "started_turn",
      result: {
        response: assistantResponse,
        model,
        thoughtLevel: effort,
        projection: {
          contextUsed: 32_000,
          contextWindow: 128_000,
          totalTokenCount: 19_400,
          turnCount: 4
        }
      }
    };
  },
  submitPrompt: async (input) => {
    if (typeof input !== "string") return { response: "Unexpected structured slash command." };
    if (input === "/resume") {
      return {
        response: "Select a session to resume.",
        selection: {
          title: "Resume Session",
          prompt: "Choose a session to resume.",
          items: [{
            command: "/resume fixture-session",
            id: "fixture-session",
            primary: "Fixture session",
            secondary: "fixture-session"
          }]
        }
      };
    }
    if (input === "/resume fixture-session") {
      return {
        resetSessionProjection: true,
        restoredMessages: [
          { role: "user", content: "Restored selected prompt." },
          { role: "agent", content: "Restored selected response." }
        ],
        response: "Resumed session fixture-session.",
        model,
        thoughtLevel: effort
      };
    }
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
