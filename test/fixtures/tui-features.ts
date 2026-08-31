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
let agentStatus = "failed";
let agentMessageCount = 0;
let timerTaskStatus: "failed" | "running" | undefined;
let turnCompleted = false;
let featureTurnActive = false;
let stuckBackgroundHandoff = false;
let escOwnedStatus: "cancelled" | "running" | undefined;
let escDeclinedStatus: "completed" | "running" | undefined;
let escUnrelatedStatus: "completed" | "running" | undefined;
const backgroundCancellationAttempts: string[] = [];
let coordinatorNoticeCount = 0;
let sessionEventListener: ((event: unknown) => void | Promise<void>) | undefined;
let featureSteerInput: string | undefined;
let featurePendingInputId: string | undefined;
let resolveFeatureSteer!: () => void;
const featureSteerReceived = new Promise<void>((resolve) => {
  resolveFeatureSteer = resolve;
});
let resolveFeatureTurnFinished!: () => void;
const featureTurnFinished = new Promise<void>((resolve) => {
  resolveFeatureTurnFinished = resolve;
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

async function emitSessionEvent(
  event: unknown,
  submissionListener?: (event: unknown) => void | Promise<void>
): Promise<void> {
  await sessionEventListener?.(event);
  await submissionListener?.(event);
}

async function emitBackgroundResultTurn(
  turnId: string,
  eventPrefix: string,
  text: string,
  inputSource: "background_task" | "subagent_message",
  duplicateText = false,
  submissionListener?: (event: unknown) => void | Promise<void>
): Promise<void> {
  await emitSessionEvent({
    id: `${eventPrefix}_start`, type: "turn_started", turnId,
    payload: { inputSource }
  }, submissionListener);
  const textEvent = {
    id: `${eventPrefix}_text`, type: "model.streaming", turnId,
    payload: {
      kind: "text_delta",
      delta: text,
      messageId: `${eventPrefix}_message`,
      partId: `${eventPrefix}_part`
    }
  };
  await emitSessionEvent(textEvent, submissionListener);
  if (duplicateText) await emitSessionEvent(textEvent, submissionListener);
  await emitSessionEvent({
    id: `${eventPrefix}_complete`, type: "turn_complete", turnId, payload: {}
  }, submissionListener);
}

async function runBackgroundCompletionTurn(
  submissionListener?: (event: unknown) => void | Promise<void>
): Promise<void> {
  await emitSessionEvent({
    id: "event_agent_reply",
    type: "subagent_message",
    payload: {
      agentId: "agent_feature",
      agentType: "reviewer",
      message: "Background agent reply stored in task activity."
    }
  }, submissionListener);
  await emitBackgroundResultTurn(
    "turn_agent_handoff",
    "event_agent_handoff",
    "Task-scoped agent handoff completed.",
    "subagent_message",
    true,
    submissionListener
  );
  await emitSessionEvent({
    id: "event_background_task_failed",
    type: "background_task_completed",
    payload: { taskId: "agent_feature", taskKind: "local_agent", status: "failed" }
  }, submissionListener);
  await emitSessionEvent({
    id: "event_background_failure_start", type: "turn_started", turnId: "turn_background_failure",
    payload: { inputSource: "background_task", originMeta: { workId: "agent_feature" } }
  }, submissionListener);
  await emitSessionEvent({
    id: "event_background_failure_reasoning", type: "model.streaming", turnId: "turn_background_failure",
    payload: { kind: "reasoning_delta", delta: "Background-only reasoning must stay in task activity." }
  }, submissionListener);
  await emitSessionEvent({
    id: "event_background_failure_tool", type: "model.streaming", turnId: "turn_background_failure",
    payload: { kind: "tool_input_start", toolCallId: "background_fetch", toolName: "Fetch" }
  }, submissionListener);
  await emitSessionEvent({
    id: "event_background_failure_text", type: "model.streaming", turnId: "turn_background_failure",
    payload: { kind: "text_delta", delta: "Coordinator began processing the failed task result." }
  }, submissionListener);
  await Bun.sleep(400);
  await emitSessionEvent({
    id: "event_background_failure", type: "turn_error", turnId: "turn_background_failure",
    payload: { error: { message: "Background result failed visibly." } }
  }, submissionListener);
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
  setTransientModel: async (modelId: string) => {
    model = modelId;
    return { model: modelId };
  },
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
  listSkills: async () => ({
    skills: [{ name: "audit", description: "Review technical quality." }]
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
    backgroundTasks: [
      {
        taskId: "bg_feature",
        taskKind: "bash",
        toolName: "Bash",
        description: turnCompleted ? "Feature background audit · turn complete" : "Feature background audit",
        command: "bun test",
        status: backgroundStatus,
        cancellable: true,
        pid: 4242,
        startedAt: Date.now() - 5_000,
        stdoutBytes: 512,
        stdoutTail: "Background audit running"
      },
      {
        taskId: "agent_feature",
        toolName: "Agent",
        description: "Review task recovery",
        status: agentStatus,
        cancellable: agentStatus === "running",
        startedAt: Date.now() - 4_000
      },
      ...(timerTaskStatus ? [{
        taskId: "timer_feature",
        toolName: "Agent",
        description: "Verify aggregate task timing",
        status: timerTaskStatus,
        cancellable: timerTaskStatus === "running",
        startedAt: Date.now() - 1_000
      }] : []),
      ...(escOwnedStatus ? [{
        taskId: "esc_owned",
        toolName: "Agent",
        description: "Current turn background agent",
        status: escOwnedStatus,
        cancellable: escOwnedStatus === "running",
        startedAt: Date.now() - 800
      }] : []),
      ...(escDeclinedStatus ? [{
        taskId: "esc_declined",
        toolName: "Agent",
        description: "Already settled background agent",
        status: escDeclinedStatus,
        cancellable: escDeclinedStatus === "running",
        startedAt: Date.now() - 700
      }] : []),
      ...(escUnrelatedStatus ? [{
        taskId: "esc_unrelated",
        toolName: "Agent",
        description: "Unrelated background agent",
        status: escUnrelatedStatus,
        cancellable: escUnrelatedStatus === "running",
        startedAt: Date.now() - 600
      }] : [])
    ],
    backgroundTaskDetails: [
      {
        taskId: "agent_feature",
        taskKind: "local_agent",
        agentId: "agent_feature",
        agentType: "reviewer",
        childSessionId: "child_feature",
        parentSessionId: "feature-session",
        turnId: "turn_feature",
        prompt: "Review the recovery path and report findings.",
        error: agentStatus === "failed" ? "The first attempt lost its provider connection." : undefined,
        status: agentStatus
      },
      ...(timerTaskStatus ? [{
        taskId: "timer_feature",
        taskKind: "local_agent",
        agentId: "timer_feature",
        agentType: "reviewer",
        childSessionId: "child_timer_feature",
        parentSessionId: "feature-session",
        turnId: "turn_timer_feature",
        prompt: "Verify aggregate task timing.",
        error: timerTaskStatus === "failed" ? "Expected timer fixture failure." : undefined,
        status: timerTaskStatus
      }] : []),
      ...(escOwnedStatus ? [{
        taskId: "esc_owned",
        taskKind: "local_agent",
        agentId: "esc_owned",
        agentType: "reviewer",
        childSessionId: "child_esc_owned",
        parentSessionId: "feature-session",
        turnId: "turn_esc_ownership",
        status: escOwnedStatus
      }] : []),
      ...(escDeclinedStatus ? [{
        taskId: "esc_declined",
        taskKind: "local_agent",
        agentId: "esc_declined",
        agentType: "reviewer",
        childSessionId: "child_esc_declined",
        parentSessionId: "feature-session",
        turnId: "turn_esc_ownership",
        status: escDeclinedStatus
      }] : []),
      ...(escUnrelatedStatus ? [{
        taskId: "esc_unrelated",
        taskKind: "local_agent",
        agentId: "esc_unrelated",
        agentType: "reviewer",
        childSessionId: "child_esc_unrelated",
        parentSessionId: "feature-session",
        turnId: "turn_older_unrelated",
        status: escUnrelatedStatus
      }] : [])
    ]
  }),
  cancelBackgroundTask: async (taskId) => {
    backgroundCancellationAttempts.push(taskId);
    if (taskId === "bg_feature") {
      backgroundStatus = "cancelled";
      return { cancelled: true, status: backgroundStatus, taskId };
    }
    if (taskId === "esc_owned") {
      escOwnedStatus = "cancelled";
      return { cancelled: true, status: escOwnedStatus, taskId };
    }
    if (taskId === "esc_declined") {
      escDeclinedStatus = "completed";
      return {
        cancelled: false,
        reason: "background_task_not_running",
        status: escDeclinedStatus,
        taskId
      };
    }
    throw new Error(`Unexpected background task: ${taskId}`);
  },
  sendBackgroundTaskMessage: async ({ taskId, message, summary, restart }) => {
    if (taskId !== "agent_feature") throw new Error(`Unexpected agent task: ${taskId}`);
    agentMessageCount += 1;
    const expectedMessage = agentMessageCount === 1
      ? "Continue the assigned task from the last completed step. Re-check the current workspace state and finish the remaining work."
      : "Restart from the saved state and finish the remaining verification.";
    if (message !== expectedMessage) throw new Error(`Unexpected agent message: ${message}`);
    if (summary !== message) throw new Error(`Unexpected agent summary: ${summary}`);
    if (restart !== (agentMessageCount === 2)) {
      throw new Error(`Unexpected restart flag for agent message ${agentMessageCount}.`);
    }
    agentStatus = "running";
    return {
      status: "success",
      delivery: "resumed_background",
      taskId,
      message: restart
        ? `Agent "${taskId}" restarted in the background.`
        : `Agent "${taskId}" resumed in the background.`
    };
  },
  interruptTurn: async ({ pendingInputIds, reason, reservationId, waitForIdle }) => {
    if (reason === "TUI interrupted the active foreground turn.") {
      if (pendingInputIds !== undefined || reservationId !== undefined || waitForIdle !== undefined) {
        throw new Error("Foreground interrupt carried background-handoff options.");
      }
      return { kind: "stopped", foregroundExecutionId: "fixture-esc-ownership" };
    }
    if (!stuckBackgroundHandoff) throw new Error("Unexpected background handoff interrupt.");
    if (pendingInputIds?.length !== 0
      || reason !== "User input preempted background result processing."
      || !reservationId?.startsWith("background_handoff_")
      || waitForIdle !== true) {
      throw new Error("Background handoff interrupt did not request an idle runtime boundary.");
    }
    stuckBackgroundHandoff = false;
    return { kind: "stopped", foregroundExecutionId: "fixture-background-handoff" };
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
  subscribeSessionEvents: (listener) => {
    sessionEventListener = listener;
    return () => {
      if (sessionEventListener === listener) sessionEventListener = undefined;
    };
  },
  sendInput: async (input, options) => {
    const prompt = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
    const promptText = typeof input === "string" ? input : prompt.text;
    if (featureTurnActive) {
      if (options.delivery !== "steer_active_turn") {
        throw new Error(`Active-turn input used unexpected delivery mode: ${String(options.delivery)}`);
      }
      if (options.queueDelivery !== "guide") {
        throw new Error(`Active steer used unexpected queue delivery: ${String(options.queueDelivery)}`);
      }
      if (promptText === "Edit this rejected steer.") {
        if (options.expectedTurnId !== "turn_feature") {
          throw new Error(`Rejected steer used unexpected expected turn: ${String(options.expectedTurnId)}`);
        }
        return {
          kind: "rejected",
          activeTurnId: "turn_feature",
          reason: "turn_not_steerable"
        };
      }
      if (promptText !== "Keep the final response concise.") {
        throw new Error(`Unexpected active-turn steer: ${String(promptText)}`);
      }
      if (options.expectedTurnId !== "turn_feature") {
        throw new Error(`Active steer used unexpected expected turn: ${String(options.expectedTurnId)}`);
      }
      if (!options.pendingInputId) throw new Error("Active steer did not provide a stable pending input ID.");
      featureSteerInput = promptText;
      featurePendingInputId = options.pendingInputId;
      await emitRuntime(options, "turn_steer_queued", {
        input: promptText,
        inputId: options.inputId,
        pendingInputId: featurePendingInputId,
        queueLength: 1,
        targetTurnId: "turn_feature"
      });
      resolveFeatureSteer();
      await featureTurnFinished;
      await Bun.sleep(50);
      return {
        kind: "queued",
        pendingInputId: featurePendingInputId,
        queueLength: 1,
        turnId: "turn_feature"
      };
    }
    if (options.delivery !== "start_turn") {
      throw new Error(`Idle input used unexpected delivery mode: ${String(options.delivery)}`);
    }
    if (typeof promptText === "string" && promptText.startsWith("Background task agent_feature")) {
      const expectedLead = coordinatorNoticeCount === 0
        ? "Background task agent_feature (Review task recovery) was resumed from the task center"
        : "Background task agent_feature (Review task recovery) was restarted from the task center";
      const expectedInstruction = coordinatorNoticeCount === 0
        ? "Continue the assigned task from the last completed step. Re-check the current workspace state and finish the remaining work."
        : "Restart from the saved state and finish the remaining verification.";
      if (!promptText.startsWith(expectedLead)
        || !promptText.includes(`\"${expectedInstruction}\"`)
        || !promptText.includes("TaskOutput with block=true")) {
        throw new Error(`Unexpected coordinator notice: ${promptText}`);
      }
      coordinatorNoticeCount += 1;
      return {
        kind: "started_turn",
        result: { turnId: `turn_task_coordinator_${coordinatorNoticeCount}` }
      };
    }
    if (promptText === "verify Esc task ownership") {
      escOwnedStatus = "running";
      escDeclinedStatus = "running";
      escUnrelatedStatus = "running";
      await emitRuntime(options, "turn_started", {
        inputId: options.inputId,
        turnId: "turn_esc_ownership"
      });
      for (const taskId of ["esc_owned", "esc_declined"]) {
        await emitRuntime(options, "background_task_started", {
          taskId,
          taskKind: "local_agent",
          status: "running",
          turnId: "turn_esc_ownership"
        });
      }
      await emit(options, {
        kind: "text_delta",
        delta: "Esc ownership turn running.\n"
      });
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(options.abortSignal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (options.abortSignal?.aborted) abort();
        else options.abortSignal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (promptText === "verify aggregate timer") {
      escUnrelatedStatus = "completed";
      timerTaskStatus = "running";
      await emitRuntime(options, "turn_started", {
        inputId: options.inputId,
        turnId: "turn_timer_feature"
      });
      await emitRuntime(options, "background_task_started", {
        taskId: "timer_feature",
        taskKind: "local_agent",
        status: "running",
        turnId: "turn_timer_feature"
      });
      setTimeout(() => {
        timerTaskStatus = "failed";
        void emitSessionEvent({
          id: "event_timer_task_failed",
          type: "background_task_updated",
          turnId: "turn_timer_feature",
          payload: {
            taskId: "timer_feature",
            taskKind: "local_agent",
            status: "failed"
          }
        });
      }, 3_500).unref?.();
      return {
        kind: "started_turn",
        result: {
          response: "Timer foreground complete; background still running.",
          model,
          thoughtLevel: effort
        }
      };
    }
    if (promptText === "Run this after the active turn.") {
      stuckBackgroundHandoff = true;
      await emitSessionEvent({
        id: "event_stuck_background_handoff",
        type: "turn_started",
        turnId: "turn_stuck_background_handoff",
        payload: { inputSource: "background_task" }
      }, options.onEvent);
      return {
        kind: "started_turn",
        result: {
          response: "Queued follow-up started after the active turn.",
          model,
          thoughtLevel: effort
        }
      };
    }
    if (promptText === "Continue after the stuck background handoff.") {
      if (stuckBackgroundHandoff) throw new Error("Stuck background handoff was not interrupted.");
      return {
        kind: "started_turn",
        result: {
          response: "Queued input started after interrupting the stuck background handoff.",
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
      typeof promptText !== "string" ||
      !promptText.startsWith("Use the skill named `audit` for this turn.\n") ||
      !promptText.includes("First call the `Skill` tool with name `audit` before doing the task.\n") ||
      !promptText.endsWith("User request:\ninspect @src/index.ts $audit") ||
      image?.type !== "image" ||
      typeof image.content !== "string"
    ) {
      throw new Error("Feature smoke prompt did not include the selected file, skill and image attachment.");
    }
    featureTurnActive = true;
    await emitRuntime(options, "turn_started", {
      inputId: options.inputId,
      turnId: "turn_feature"
    });
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
    const interleavedModelBlocks = [
      { reasoning: "Inspecting ", text: "我会检查 vercel-l" },
      { reasoning: "the repository ", text: "abs/native 与 Compose Desktop" },
      { reasoning: "before using tools.", text: " 的 WebView 路径。" }
    ];
    for (const [index, block] of interleavedModelBlocks.entries()) {
      const reasoningPartId = `stream_reasoning_${index}`;
      const textPartId = `stream_text_${index}`;
      await emit(options, { kind: "reasoning_start", partId: reasoningPartId });
      await emit(options, { kind: "reasoning_delta", partId: reasoningPartId, delta: block.reasoning });
      await emit(options, { kind: "reasoning_end", partId: reasoningPartId });
      await emit(options, { kind: "text_start", partId: textPartId });
      await emit(options, { kind: "text_delta", partId: textPartId, delta: block.text });
      await emit(options, { kind: "text_end", partId: textPartId });
    }
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
        input: {
          agentType: "explore",
          description: "Inspect nested rendering",
          prompt: "Read child.ts",
          run_in_background: true
        }
      }
    };
    await emitRuntime(options, "part.started", { part: agentPart });
    await emitRuntime(options, "part.started", {
      part: {
        type: "reasoning",
        partId: "part_agent_coordination",
        messageId: "message_assistant",
        text: "Coordinator dispatching background research; this belongs in Tasks."
      }
    });
    await emitRuntime(options, "subagent_spawned", {
      parentToolCallId: "call_agent",
      agentId: "agent_feature",
      agentType: "explore",
      childSessionId: "session_feature_child",
      description: "Inspect nested rendering"
    });
    const childPart = {
      type: "tool",
      partId: "part_child_fetch",
      messageId: "message_assistant",
      callId: "call_child_fetch",
      tool: "Fetch",
      state: {
        status: "running",
        input: { url: "https://github.com/example/background-research" },
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
          output: "Background research result"
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
    await Promise.race([featureSteerReceived, Bun.sleep(8_000)]);
    if (!featureSteerInput) throw new Error("Feature smoke did not receive active-turn steering.");
    if (!featurePendingInputId) throw new Error("Feature smoke did not retain the pending input ID.");
    await Bun.sleep(150);
    await emitRuntime(options, "turn_steer_drained", {
      injectedMessageIds: ["message_steer"],
      pendingInputIds: [featurePendingInputId],
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
    resolveFeatureTurnFinished();
    await runBackgroundCompletionTurn(options.onEvent);
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

if (process.env.ZCODE_TUI_FEATURE_SMOKE === "1") {
  if (coordinatorNoticeCount !== 2) {
    throw new Error(`Expected two coordinator notices, received ${coordinatorNoticeCount}.`);
  }
  if (backgroundCancellationAttempts.join(",") !== "esc_owned,esc_declined") {
    throw new Error(`Unexpected Esc cancellation attempts: ${backgroundCancellationAttempts.join(",")}`);
  }
}
