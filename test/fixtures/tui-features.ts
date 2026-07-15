#!/usr/bin/env bun

import { join } from "node:path";

import { runTui } from "../../packages/zcode-tui/src/index.ts";
import type { PromptCallOptions } from "../../packages/zcode-tui/src/types.ts";

if (process.argv[2] === "login") {
  if (!process.argv.includes("--oauth")) {
    console.error("Error: explicit Z.AI login did not force OAuth");
    process.exit(1);
  }
  if (process.env.ZCODE_FIXTURE_LOGIN_FAIL === "1") {
    console.error("Error: OAuth HTTP error 404 (empty or non-JSON response)");
    process.exit(1);
  }
  await import("./tui-login-override.ts");
  process.exit(0);
}

let model = "alpha/model";
let effort = "low";
let backgroundStatus = "running";
let turnCompleted = false;
let featureTurnActive = false;
let featureSteerInput: string | undefined;
let resolveFeatureSteer!: () => void;
const featureSteerReceived = new Promise<void>((resolve) => {
  resolveFeatureSteer = resolve;
});
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
const approvalPlan = [
  "# Implementation Plan",
  "",
  ...Array.from({ length: 36 }, (_, index) => (
    `${index + 1}. Complete detailed implementation step ${index + 1}.`
  ))
].join("\n");

let sessionTranscript = [
  { messageId: "message_startup", role: "user", content: "Restored startup prompt." },
  { messageId: "message_startup_reply", role: "agent", content: "Restored startup response." },
  { messageId: "message_later", role: "user", content: "Restored later prompt." },
  { messageId: "message_later_reply", role: "agent", content: "Restored later response." }
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
  theme: process.env.ZCODE_TUI_TEST_THEME,
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
    { name: "login", description: "Configure model access" },
    { name: "mcp", description: "Manage MCP" },
    { name: "workflows", description: "Manage workflows" },
    { name: "goal", description: "Manage the session goal" }
  ],
  loadSessionTranscript: async () => sessionTranscript,
  readClipboardImage: async () => ({
    dataUrl: "data:image/png;base64,aGVsbG8=",
    mediaType: "image/png",
    sizeBytes: 5
  }),
  listMcpServers: async () => ({
    docs: { status: "disconnected", transport: "stdio", toolCount: 2 }
  }),
  listWorkspacePathSuggestions: async ({ token, abortSignal }) => {
    if (abortSignal?.aborted) return { items: [], truncated: false };
    return token === "@ind"
      ? { items: [{ kind: "file" as const, path: "src/index.ts" }], truncated: false }
      : { items: [], truncated: false };
  },
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
  previewFileRewind: async (targetMessageIds) => {
    if (!targetMessageIds.every((messageId) => sessionTranscript.some((message) => message.messageId === messageId))) {
      throw new Error(`Unexpected rewind preview targets: ${targetMessageIds.join(", ")}`);
    }
    return {
      canApply: true,
      safeFiles: [{ path: "src/rewind-fixture.ts", action: "restore", operationCount: 1, toolNames: ["Edit"] }],
      unsafeFiles: [],
      ignoredFiles: [{ path: "tmp/bash-output.txt", reason: "bash_ignored", operationCount: 1, toolNames: ["Bash"] }]
    };
  },
  applyFileRewind: async (targetMessageIds) => {
    if (!targetMessageIds.includes("message_later") || !targetMessageIds.includes("message_later_reply")) {
      throw new Error(`Unexpected file rewind targets: ${targetMessageIds.join(", ")}`);
    }
    return { applied: true, response: "Rewound fixture workspace files." };
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
    const promptText = typeof input === "string" ? input : prompt.text;
    if (featureTurnActive) {
      if (options.delivery !== "steer_active_turn") {
        throw new Error(`Active-turn input used unexpected delivery mode: ${String(options.delivery)}`);
      }
      if (promptText === "Edit this rejected steer.") {
        return {
          kind: "rejected",
          activeTurnId: "turn_feature",
          reason: "turn_not_steerable"
        };
      }
      if (promptText !== "Keep the final response concise.") {
        throw new Error(`Unexpected active-turn steer: ${String(promptText)}`);
      }
      featureSteerInput = promptText;
      const pendingInputId = "pending_feature_1";
      await emitRuntime(options, "turn_steer_queued", {
        input: promptText,
        inputId: options.inputId,
        pendingInputId,
        queueLength: 1,
        targetTurnId: "turn_feature"
      });
      resolveFeatureSteer();
      return { kind: "queued", pendingInputId, queueLength: 1, turnId: "turn_feature" };
    }
    if (options.delivery !== "start_turn") {
      throw new Error(`Idle input used unexpected delivery mode: ${String(options.delivery)}`);
    }
    if (promptText === "Run this after the active turn.") {
      return {
        kind: "started_turn",
        result: {
          response: "Queued follow-up started after the active turn.",
          model,
          thoughtLevel: effort
        }
      };
    }
    if (promptText === "review long plan" || promptText === "review plan feedback") {
      if (!options.requestPermission) throw new Error("Plan approval callback is unavailable.");
      const approval = await options.requestPermission({
        input: { plan: approvalPlan },
        toolCallId: "call_exit_plan",
        toolName: "ExitPlanMode"
      }, { abortSignal: options.abortSignal });
      const decision = typeof approval === "object" && approval !== null
        ? String((approval as Record<string, unknown>).decision ?? "unknown")
        : "unknown";
      const reasonSource = typeof approval === "object" && approval !== null
        ? (approval as Record<string, unknown>).reasonSource
        : undefined;
      return {
        kind: "started_turn",
        result: {
          response: `Plan approval fixture complete: ${decision}${reasonSource ? ` · ${String(reasonSource)}` : ""}.`,
          model,
          thoughtLevel: effort
        }
      };
    }
    const attachments = Array.isArray(prompt.attachments) ? prompt.attachments : [];
    const image = attachments[0] as Record<string, unknown> | undefined;
    if (
      promptText !== "inspect @src/index.ts" ||
      image?.type !== "image" ||
      typeof image.content !== "string"
    ) {
      throw new Error("Feature smoke prompt did not include the selected file and image attachment.");
    }
    featureTurnActive = true;
    await emitRuntime(options, "model.network_status", {
      type: "model_request_started",
      attempt: 1,
      maxAttempts: 6
    });
    await emitRuntime(options, "model.network_status", {
      type: "model_stream_stalled",
      attempt: 1,
      maxAttempts: 6,
      idleMs: 60_000,
      timeoutMs: 60_000,
      message: "Model stream stalled: no event received for 60000ms."
    });
    await emitRuntime(options, "model.network_status", {
      type: "model_request_failed",
      attempt: 1,
      maxAttempts: 6,
      retryable: true,
      message: "Model stream idle timeout."
    });
    await emitRuntime(options, "model.network_status", {
      type: "model_retry_scheduled",
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 6,
      delayMs: 1_000,
      retryable: true,
      message: "Retrying after model stream idle timeout."
    });
    await emitRuntime(options, "model.network_status", {
      type: "model_request_started",
      attempt: 2,
      maxAttempts: 6
    });
    await emitRuntime(options, "model.network_status", {
      type: "model_request_completed",
      attempt: 2,
      maxAttempts: 6
    });
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
    await Promise.race([featureSteerReceived, Bun.sleep(3_000)]);
    if (!featureSteerInput) throw new Error("Feature smoke did not receive active-turn steering.");
    await Bun.sleep(150);
    await emitRuntime(options, "turn_steer_drained", {
      injectedMessageIds: ["message_steer"],
      pendingInputIds: ["pending_feature_1"],
      targetTurnId: "turn_feature"
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
    featureTurnActive = false;
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
    if (input.startsWith("/rewind cascade conversation ")) {
      const targetMessageId = input.slice("/rewind cascade conversation ".length);
      const targetIndex = sessionTranscript.findIndex((message) => message.messageId === targetMessageId);
      if (targetIndex < 0) throw new Error(`Unexpected conversation rewind target: ${targetMessageId}`);
      sessionTranscript = sessionTranscript.slice(0, targetIndex);
      return { response: `Rewound conversation before ${targetMessageId}.`, model, thoughtLevel: effort };
    }
    if (input === "/login") {
      return {
        response: "Choose how to configure model access.",
        selection: {
          title: "Set Up Coding Plan",
          prompt: "Choose a setup method.",
          items: [
            {
              command: "/login zai-coding-plan-api-key",
              id: "zai-coding-plan-api-key",
              primary: "Z.AI Coding Plan API Key",
              secondary: "Paste an API key manually.",
              input: {
                cancelStatus: "API key entry cancelled.",
                emptyStatus: "API key is required.",
                help: "Enter saves the key. Esc cancels.",
                mask: true,
                placeholder: "Paste API key",
                primary: "Enter Z.AI Coding Plan API Key",
                secondary: "The key is hidden while typing.",
                submitStatus: "Saving API key..."
              }
            },
            {
              command: "/login zai-coding-plan",
              id: "zai-coding-plan",
              primary: "Z.AI Coding Plan",
              secondary: "Run the official browser OAuth flow.",
              pending: {
                cancelStatus: "Login cancelled.",
                help: "Esc cancels.",
                primary: "Waiting for Z.AI authorization",
                secondary: "Complete sign-in in the browser.",
                status: "Waiting for browser authorization..."
              }
            }
          ]
        }
      };
    }
    if (input === "/login zai-coding-plan-api-key feature-secret-api-key") {
      const override = join(import.meta.dir, "tui-login-override.ts").replaceAll("'", "'\\''");
      process.env.ZCODE_TUI_LOGIN_CMD = `'${process.execPath}' '${override}'`;
      return {
        loginRequired: false,
        model,
        response: "Configured Z.AI Coding Plan."
      };
    }
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
    if (input === "/disable-login-override") {
      delete process.env.ZCODE_TUI_LOGIN_CMD;
      return { response: "Login override disabled.", model, thoughtLevel: effort };
    }
    if (input === "/prepare-failing-login") {
      process.env.ZCODE_FIXTURE_LOGIN_FAIL = "1";
      return { response: "Failing login prepared.", model, thoughtLevel: effort };
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
        mode: "build",
        model,
        thoughtLevel: effort,
        effortOptions: [{ id: "low", label: "Low" }, { id: "high", label: "High" }]
      };
    }
    if (input.startsWith("/effort ")) {
      effort = input.slice("/effort ".length);
      return { response: `Reasoning effort switched to ${effort}.`, mode: "build", model, thoughtLevel: effort };
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
