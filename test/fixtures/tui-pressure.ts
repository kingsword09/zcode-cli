#!/usr/bin/env bun

import { runTui } from "../../packages/zcode-tui/src/index.ts";
import type { PromptCallOptions } from "../../packages/zcode-tui/src/types.ts";

const steerText = "长任务期间继续检查输入响应。";
const outputTail = Array.from(
  { length: 120 },
  (_, index) => `pressure line ${index + 1} ${"x".repeat(64)}`
).join("\n");

let active = false;
let steerReceived = false;
const pressurePendingInputId = "pressure_pending";
let resolveSteer!: () => void;
const steerPromise = new Promise<void>((resolve) => {
  resolveSteer = resolve;
});

function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null) return "";
  const text = (input as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

async function emit(options: PromptCallOptions, type: string, payload: unknown): Promise<void> {
  await options.onEvent?.({ type, payload });
}

async function runPressureTurn(
  options: PromptCallOptions,
  cancellable: boolean
): Promise<unknown> {
  const toolCallId = cancellable ? "pressure_cancel" : "pressure_steer";
  const command = cancellable ? "cancel-pressure" : "steer-pressure";
  const partId = `${toolCallId}_part`;
  active = true;
  try {
    await options.onEvent?.({ kind: "tool_input_start", toolCallId, toolName: "Bash" });
    for (let index = 0; index < 10_000; index += 1) {
      void options.onEvent?.({
        kind: "tool_input_delta",
        delta: "0123456789",
        toolCallId,
        toolName: "Bash"
      });
    }
    await Bun.sleep(30);
    await options.onEvent?.({
      kind: "tool_call",
      input: { command },
      toolCallId,
      toolName: "Bash"
    });
    await emit(options, "tool_call_started", {
      input: { command },
      toolCallId,
      toolName: "Bash"
    });
    await emit(options, "part.started", {
      part: {
        type: "tool",
        partId,
        callId: toolCallId,
        tool: "Bash",
        state: { status: "running", input: { command } }
      }
    });
    for (let index = 0; index < 10_000; index += 1) {
      void options.onEvent?.({
        type: "part.delta",
        payload: { partId, field: "output", delta: "0123456789" }
      });
    }
    await Bun.sleep(30);
    for (let index = 0; index < (cancellable ? 100_000 : 5_000); index += 1) {
      if (options.abortSignal?.aborted) throw new Error("Pressure turn cancelled.");
      await emit(options, "tool_call_progress", {
        elapsedMs: index,
        input: { command },
        stdoutBytes: index * 80,
        stdoutTail: `${outputTail}\n${cancellable ? "cancel" : "steer"} frame ${index}`,
        toolCallId,
        toolName: "Bash"
      });
      if (index % 50 === 49) await Bun.sleep(5);
    }
    if (!cancellable) {
      await Promise.race([steerPromise, Bun.sleep(2_000)]);
      if (!steerReceived) throw new Error("Pressure fixture did not receive steering input.");
    }
    await emit(options, "tool_call_result", {
      input: { command },
      result: { exitCode: 0, stdout: "Pressure output complete.", success: true },
      toolCallId,
      toolName: "Bash"
    });
    await emit(options, "turn_steer_drained", {
      injectedMessageIds: ["pressure_steer_message"],
      pendingInputIds: [pressurePendingInputId],
      targetTurnId: "pressure_turn"
    });
    return {
      kind: "started_turn",
      result: {
        response: "Pressure turn complete.",
        model: "pressure/model",
        thoughtLevel: "medium"
      }
    };
  } finally {
    active = false;
  }
}

await runTui({
  initialMode: "build",
  initialModel: "pressure/model",
  initialThoughtLevel: "medium",
  noColor: true,
  version: "pressure-smoke",
  workspaceDirectory: process.cwd(),
  readSessionUsage: async () => ({ totalTokens: 0 }),
  sendInput: async (input, options) => {
    const text = inputText(input);
    if (active) {
      if (options.delivery !== "steer_active_turn") {
        throw new Error(`Pressure steer used unexpected delivery mode: ${String(options.delivery)}`);
      }
      if (text !== steerText) throw new Error(`Unexpected pressure steer: ${text}`);
      steerReceived = true;
      await emit(options, "turn_steer_queued", {
        input: text,
        inputId: options.inputId,
        pendingInputId: pressurePendingInputId,
        queueLength: 1,
        targetTurnId: "pressure_turn"
      });
      resolveSteer();
      return { kind: "queued", pendingInputId: pressurePendingInputId, queueLength: 1 };
    }
    if (options.delivery !== "start_turn") {
      throw new Error(`Pressure turn used unexpected delivery mode: ${String(options.delivery)}`);
    }
    if (text === "stress") return await runPressureTurn(options, false);
    if (text === "cancel stress") return await runPressureTurn(options, true);
    throw new Error(`Unexpected pressure prompt: ${text}`);
  },
  submitPrompt: async () => ({ response: "Unexpected fallback submission." })
});
