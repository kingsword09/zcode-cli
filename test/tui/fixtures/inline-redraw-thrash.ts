#!/usr/bin/env bun

import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import { createScenarioRuntime, type ScenarioRuntimeStep } from "../runtime/scenario-runtime.ts";

// Reproduces the issue #260 trigger profile: a live Bash card whose stdoutTail
// preview grows past a short terminal viewport while progress ticks keep
// rewriting the card. With the default 16-line collapsed preview the card
// header leaves the viewport and every tick forced a full screen clear plus
// scrollback wipe in the inline renderer.
const ROUNDS = 2;
const PREVIEW_LINES = 40;
const TICKS = 10;
const TICK_DELAY_MS = 120;
const lineWidth = Number(process.env.ZCODE_TEST_THRASH_LINE_WIDTH ?? 0);

const preview = (round: number, lines: number): string =>
  Array.from({ length: Math.min(lines, PREVIEW_LINES) }, (_, lineIndex) =>
    `${String(lineIndex + 1).padStart(3, " ")} | df = spark.table("dwh.fct_trade_order_events").where(f.col("ds") == "2026101${round % 10}")`.padEnd(lineWidth, "x")
  ).join("\n");

const steps: ScenarioRuntimeStep[] = [];
for (let round = 0; round < ROUNDS; round++) {
  steps.push(
    { type: "emit", event: { type: "text_delta", kind: "text_delta", messageId: `m${round}`, delta: `Round ${round}: re-running the aggregation for the textual section.` } },
    { type: "emit", event: { type: "tool_input_start", kind: "tool_input_start", toolCallId: `t${round}`, toolName: "Bash", partId: `p${round}`, messageId: `m${round}` } },
    { type: "emit", event: { type: "tool_input_delta", kind: "tool_input_delta", toolCallId: `t${round}`, delta: JSON.stringify({ command: `python3 -c "round_${round}()"` }) } },
    { type: "emit", event: { type: "tool_input_end", kind: "tool_input_end", toolCallId: `t${round}` } },
    { type: "emit", event: { type: "tool_call", kind: "tool_call", toolCallId: `t${round}`, toolName: "Bash", input: { command: `python3 -c "round_${round}()"` } } },
    ...Array.from({ length: TICKS }, (_, tick): ScenarioRuntimeStep[] => [
      {
        type: "emit",
        event: {
          type: "progress",
          kind: "progress",
          toolCallId: `t${round}`,
          elapsedMs: (tick + 1) * TICK_DELAY_MS,
          stdoutBytes: (tick + 1) * 1024,
          stdoutTail: preview(round, 6 + tick * 4)
        }
      },
      { type: "delay", milliseconds: TICK_DELAY_MS }
    ]).flat(),
    { type: "delay", milliseconds: 150 },
    { type: "emit", event: { type: "result", kind: "result", toolCallId: `t${round}`, result: preview(round, PREVIEW_LINES), progress: { durationMs: TICKS * TICK_DELAY_MS } } },
    { type: "emit", event: { type: "closed", kind: "closed", toolCallId: `t${round}` } },
    { type: "delay", milliseconds: 50 }
  );
}
steps.push(
  { type: "emit", event: { type: "text_delta", kind: "text_delta", messageId: "mfinal", delta: "All rounds complete." } },
  { type: "delay", milliseconds: 120 },
  { type: "respond", response: "done" }
);

const runtime = createScenarioRuntime({
  unmatchedResponse: "Type go to start.",
  turns: [{ id: "thrash-turn", match: "go", steps }]
});

await runTui({
  version: "inline-redraw-thrash-scenario",
  workspaceDirectory: process.cwd(),
  initialMode: "build",
  initialModel: "scenario/model",
  modelOptions: [{ alias: "main", id: "scenario/model", name: "Scenario" }],
  loadSessionTranscript: async () => [],
  submitPrompt: runtime.submitPrompt,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
} as Parameters<typeof runTui>[0]);
