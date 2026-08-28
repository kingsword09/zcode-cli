#!/usr/bin/env bun

import { runTui } from "../../packages/zcode-tui/src/index.ts";
import type { PromptCallOptions } from "../../packages/zcode-tui/src/types.ts";

const steerText = "长任务期间继续检查输入响应。";
const recoveredSteerTexts = [
  "Esc 后立即提交第一条 steer。",
  "合并第二条 steer 并继续当前上下文。"
] as const;
const recoveredSteerText = recoveredSteerTexts.join("\n");
const outputTail = Array.from(
  { length: 120 },
  (_, index) => `pressure line ${index + 1} ${"x".repeat(64)}`
).join("\n");

let active = false;
let activeTurnInterrupt: AbortController | undefined;
let steerReceived = false;
const hangingSteerPendingIds: string[] = [];
let interruptedContextEstablished = false;
let interruptReservationId: string | undefined;
let promotedPendingInputIds: string[] | undefined;
let pressurePendingInputId: string | undefined;
const pressureSteerTurnId = "pressure_steer_turn";
const pressureCancelTurnId = "pressure_cancel_turn";
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
  const turnId = cancellable ? pressureCancelTurnId : pressureSteerTurnId;
  const partId = `${toolCallId}_part`;
  const semanticInterrupt = new AbortController();
  active = true;
  activeTurnInterrupt = semanticInterrupt;
  try {
    await emit(options, "turn_started", {
      inputId: options.inputId,
      turnId
    });
    if (cancellable) interruptedContextEstablished = true;
    if (cancellable) {
      await options.onEvent?.({
        kind: "text_delta",
        delta: "Context established before steer interrupt.\n",
        messageId: "pressure_context_message",
        partId: "pressure_context_part"
      });
    }
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
      if (options.abortSignal?.aborted || semanticInterrupt.signal.aborted) {
        await emit(options, "tool_call_error", {
          error: {
            type: "tool_cancelled",
            message: "Bash was cancelled and the child process was asked to stop",
            code: "TOOL_CANCELLED",
            stack: "Error: internal vendor stack"
          },
          input: { command },
          toolCallId,
          toolName: "Bash"
        });
        if (semanticInterrupt.signal.aborted) {
          await emit(options, "model.network_status", {
            type: "model_request_failed",
            attempt: 1,
            errorCode: "model_request_cancelled",
            exceptionType: "AbortError",
            message: "Model request was cancelled.",
            reason: "cancelled",
            retryable: false
          });
        }
        throw new Error("Pressure turn cancelled.");
      }
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
      if (!pressurePendingInputId) throw new Error("Pressure steer did not receive a pending input ID.");
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
      targetTurnId: turnId
    });
    if (!cancellable) await Bun.sleep(250);
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
    if (activeTurnInterrupt === semanticInterrupt) activeTurnInterrupt = undefined;
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
  interruptTurn: async ({ pendingInputIds, reason, reservationId }) => {
    if (!active || !activeTurnInterrupt) return { kind: "idle" };
    if (reason?.includes("active foreground turn")) {
      if (pendingInputIds?.length) {
        throw new Error(`Foreground interrupt received pending inputs: ${pendingInputIds.join(", ")}`);
      }
      // Model runtimes may acknowledge stop without aborting the TUI's local
      // submission signal. ZCode must settle that signal and timer itself.
      return { kind: "stopped" };
    }
    if (!reason?.includes("steer instructions")) {
      throw new Error(`Unexpected semantic interrupt reason: ${String(reason)}`);
    }
    if (pendingInputIds?.length !== hangingSteerPendingIds.length
      || pendingInputIds.some((pendingInputId, index) => pendingInputId !== hangingSteerPendingIds[index])) {
      throw new Error(`Semantic interrupt received unexpected pending inputs: ${pendingInputIds?.join(", ")}`);
    }
    if (!reservationId) throw new Error("Semantic interrupt did not provide a queue reservation ID.");
    interruptReservationId = reservationId;
    activeTurnInterrupt.abort(new Error(reason));
    return { kind: "stopped" };
  },
  sendInput: async (input, options) => {
    const text = inputText(input);
    if (active) {
      if (options.delivery !== "steer_active_turn") {
        throw new Error(`Pressure steer used unexpected delivery mode: ${String(options.delivery)}`);
      }
      if (text !== steerText && !recoveredSteerTexts.includes(text as typeof recoveredSteerTexts[number])) {
        throw new Error(`Unexpected pressure steer: ${text}`);
      }
      const recovery = text !== steerText;
      const expectedTurnId = recovery ? pressureCancelTurnId : pressureSteerTurnId;
      if (options.expectedTurnId !== expectedTurnId) {
        throw new Error(`Pressure steer used unexpected expected turn: ${String(options.expectedTurnId)}`);
      }
      if (!options.pendingInputId) throw new Error("Pressure steer did not provide a stable pending input ID.");
      await emit(options, "turn_steer_queued", {
        input: text,
        inputId: options.inputId,
        pendingInputId: options.pendingInputId,
        queueLength: 1,
        targetTurnId: expectedTurnId
      });
      if (recovery) {
        hangingSteerPendingIds.push(options.pendingInputId);
        return await new Promise<never>(() => {});
      }
      pressurePendingInputId = options.pendingInputId;
      steerReceived = true;
      resolveSteer();
      return { kind: "queued", pendingInputId: options.pendingInputId, queueLength: 1 };
    }
    if (options.delivery !== "start_turn") {
      throw new Error(`Pressure turn used unexpected delivery mode: ${String(options.delivery)}`);
    }
    if (text === "stress") return await runPressureTurn(options, false);
    if (text === "cancel stress") return await runPressureTurn(options, true);
    if (text === recoveredSteerText) {
      throw new Error("Recovered steer bypassed queued-input promotion.");
    }
    throw new Error(`Unexpected pressure prompt: ${text}`);
  },
  promoteQueuedInput: async (input, pendingInputIds, options) => {
    const text = inputText(input);
    if (text !== recoveredSteerText) throw new Error(`Unexpected promoted steer: ${text}`);
    if (pendingInputIds.length !== hangingSteerPendingIds.length
      || pendingInputIds.some((pendingInputId, index) => pendingInputId !== hangingSteerPendingIds[index])) {
      throw new Error(`Promoted unexpected pending inputs: ${pendingInputIds.join(", ")}`);
    }
    if (promotedPendingInputIds) throw new Error("Recovered steers were promoted more than once.");
    if (hangingSteerPendingIds.length !== recoveredSteerTexts.length) {
      throw new Error("Recovered steer waited for the original steer RPC to finish.");
    }
    if (!interruptedContextEstablished) {
      throw new Error("Recovered steer lost the interrupted turn context.");
    }
    if (active) throw new Error("Recovered steer was promoted before the interrupted turn stopped.");
    if (options.delivery !== "start_turn") {
      throw new Error(`Promoted steer used unexpected delivery mode: ${String(options.delivery)}`);
    }
    if (!interruptReservationId || options.pendingInputReservationId !== interruptReservationId) {
      throw new Error("Promoted steer did not reuse the semantic interrupt reservation.");
    }
    promotedPendingInputIds = [...pendingInputIds];
    await emit(options, "turn_started", {
      inputId: options.inputId,
      turnId: "pressure_continuation_turn"
    });
    return {
      kind: "started_turn",
      result: {
        response: "Interrupted model step continued with steer instructions.",
        turnId: "pressure_continuation_turn",
        model: "pressure/model",
        thoughtLevel: "medium"
      }
    };
  },
  submitPrompt: async () => ({ response: "Unexpected fallback submission." })
});
