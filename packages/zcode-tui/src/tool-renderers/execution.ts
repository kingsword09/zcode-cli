import { sanitizeTerminalText, truncateGraphemes } from "../terminal-text.ts";
import { isRecord } from "../types.ts";
import type { SpecializedToolRenderOptions, SpecializedToolRenderResult } from "./types.ts";
import {
  booleanField,
  compactStatusLine,
  directText,
  formatBytes,
  formatElapsed,
  nestedRecord,
  numberField,
  oneLine,
  recordString,
  toolSummary
} from "./helpers.ts";
import { canonicalToolName } from "./registry.ts";

export function bashRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const { progress, result, theme } = options;
  const record = nestedRecord(result);
  const stdout = progress?.stdoutTail
    ? sanitizeTerminalText(progress.stdoutTail)
    : recordString(record, ["stdout", "output"]) ?? directText(result);
  const stderr = progress?.stderrTail
    ? sanitizeTerminalText(progress.stderrTail)
    : recordString(record, ["stderr"]);
  const duration = progress?.elapsedMs
    ?? progress?.durationMs
    ?? numberField(record, ["durationMs", "duration"]);
  const exitCode = numberField(record, ["exitCode", "exit_code", "code"]);
  const backgroundTaskId = recordString(record, ["backgroundTaskId", "background_task_id", "taskId", "task_id"]);
  const body: string[] = [];
  const status = compactStatusLine([
    formatElapsed(duration),
    progress?.pid !== undefined ? `pid ${progress.pid}` : undefined,
    exitCode !== undefined ? `exit ${exitCode}` : undefined,
    progress?.stdoutBytes ? `${formatBytes(progress.stdoutBytes)} stdout` : undefined,
    progress?.stderrBytes ? `${formatBytes(progress.stderrBytes)} stderr` : undefined,
    progress?.outputBytes ? `${formatBytes(progress.outputBytes)} output` : undefined
  ], theme);
  if (status) body.push(status);
  if (backgroundTaskId) body.push(theme.muted(`Background task ${backgroundTaskId}`));
  if (stdout?.trim()) body.push(stdout.trimEnd());
  if (stderr?.trim()) body.push(theme.error(stderr.trimEnd()));
  if (body.length === 0 && ["complete", "completed", "success"].includes(options.state.toLowerCase())) {
    body.push(theme.muted("Done (no output)"));
  }
  return {
    displayName: "Bash",
    summary: toolSummary(options.name, options.input),
    body: body.join("\n") || undefined,
    consumesResult: true
  };
}

export function agentRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const input = isRecord(options.input) ? options.input : undefined;
  const status = recordString(record, ["status"]);
  const duration = numberField(record, ["totalDurationMs", "durationMs"])
    ?? options.progress?.elapsedMs
    ?? options.progress?.durationMs;
  const toolCount = numberField(record, ["totalToolUseCount", "toolUseCount"]);
  const resolvedToolCount = toolCount ?? options.progress?.totalToolUseCount;
  const tokens = numberField(record, ["totalTokens"]) ?? options.progress?.totalTokens;
  const agentId = recordString(record, ["agentId"])
    ?? options.progress?.agentId;
  const childSessionId = recordString(record, ["childSessionId"])
    ?? options.progress?.childSessionId;
  const backgroundTaskId = recordString(record, ["backgroundTaskId", "taskId"]) ?? options.progress?.backgroundTaskId;
  const outputFile = recordString(record, ["outputFile", "output_file"]) ?? options.progress?.outputFile;
  const agentType = recordString(record, ["agentType"])
    ?? recordString(input, ["agentType", "agent_type", "subagent_type"])
    ?? options.progress?.agentType;
  const model = recordString(record, ["model"])
    ?? recordString(input, ["model"]);
  const prompt = recordString(record, ["prompt"])
    ?? recordString(input, ["prompt"]);
  const stats = [
    status,
    resolvedToolCount !== undefined ? `${resolvedToolCount} tool ${resolvedToolCount === 1 ? "use" : "uses"}` : undefined,
    tokens !== undefined ? `${tokens.toLocaleString()} tokens` : undefined,
    formatElapsed(duration)
  ].filter(Boolean).join(" · ");
  const progress = options.progress?.description
    ? sanitizeTerminalText(options.progress.description, { preserveSgr: false })
    : undefined;
  const content = directText(record?.content ?? record?.response ?? record?.output ?? record?.text);
  const metadata = [
    stats && options.theme.muted(`└ ${stats}`),
    agentId && options.theme.muted(`agent ${agentId}${childSessionId ? ` · session ${childSessionId}` : ""}`),
    (agentType || model) && options.theme.muted([agentType && `type ${agentType}`, model && `model ${model}`].filter(Boolean).join(" · ")),
    backgroundTaskId && options.theme.muted(`background task ${backgroundTaskId}`),
    outputFile && options.theme.muted(`output ${outputFile}`),
    progress && options.theme.muted(options.expanded ? progress : oneLine(progress))
  ].filter(Boolean);
  const details = options.expanded
    ? [
      prompt && `${options.theme.bold("Prompt:")}\n${prompt}`,
      content && `${options.theme.bold("Response:")}\n${content}`
    ].filter(Boolean)
    : [];
  const recognized = Boolean(record && (status || resolvedToolCount !== undefined || tokens !== undefined || agentId || backgroundTaskId || content || outputFile));
  return {
    displayName: canonicalToolName(options.name) === "Task" ? "Task" : "Agent",
    summary: toolSummary(options.name, options.input),
    body: [...metadata, ...details].join("\n") || undefined,
    consumesResult: recognized,
    hiddenContent: Boolean(content || prompt) && !options.expanded
  };
}

export function taskStopRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const taskId = recordString(record, ["task_id", "taskId"])
    ?? recordString(isRecord(options.input) ? options.input : undefined, ["task_id", "taskId", "shell_id", "shellId"]);
  const taskType = recordString(record, ["task_type", "taskType"]);
  const command = recordString(record, ["command"]);
  const message = recordString(record, ["message"]);
  return {
    displayName: "Stop task",
    summary: taskId ? `${taskId}${taskType ? ` · ${taskType}` : ""}` : toolSummary(options.name, options.input),
    body: [command && `${oneLine(command, 160)} · stopped`, !command && message ? message : undefined].filter(Boolean).join("\n") || undefined,
    consumesResult: Boolean(record)
  };
}

interface TaskOutputDisplay {
  retrievalStatus?: string;
  taskStatus?: string;
  output?: string;
  truncated?: boolean;
  source: "display" | "fallback";
}

const taskOutputDisplayLimit = 2_000;

const retrievalStatusLabels: Record<string, string> = {
  success: "retrieved",
  not_ready: "not ready yet",
  timeout: "timed out waiting"
};

function taskOutputDisplayFromTask(record: Record<string, unknown>): TaskOutputDisplay | undefined {
  const task = isRecord(record.task) ? record.task : undefined;
  const retrievalStatus = recordString(record, ["retrieval_status", "retrievalStatus"]);
  if (!task && !retrievalStatus) return undefined;
  return {
    retrievalStatus,
    taskStatus: recordString(task, ["status"]),
    source: "fallback"
  };
}

function taskOutputDisplayFromString(value: string): TaskOutputDisplay | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const fromJson = isRecord(parsed) ? taskOutputDisplayFromTask(parsed) : undefined;
      if (fromJson) return fromJson;
    } catch {
      // Not a serialized runtime result; fall through to the model-content shape.
    }
  }
  if (value.includes("<retrieval_status>")) {
    const status = /<retrieval_status>([^<]+)<\/retrieval_status>/u.exec(value)?.[1];
    const taskStatus = /<status>([^<]+)<\/status>/u.exec(value)?.[1];
    if (status || taskStatus) {
      return {
        retrievalStatus: status ? sanitizeTerminalText(status.trim(), { preserveSgr: false }) : undefined,
        taskStatus: taskStatus ? sanitizeTerminalText(taskStatus.trim(), { preserveSgr: false }) : undefined,
        source: "fallback"
      };
    }
  }
  return undefined;
}

function compactTaskOutput(value: unknown): { output?: string; truncated: boolean } {
  const raw = directText(value)?.trimEnd();
  if (!raw) return { truncated: false };
  const output = truncateGraphemes(raw, taskOutputDisplayLimit, "");
  return { output, truncated: output !== raw };
}

function taskOutputFailureMessage(result: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      return taskOutputFailureMessage(JSON.parse(trimmed), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(result)) return undefined;
  const failed = result.success === false || result.result === false;
  if (failed) {
    const message = recordString(result, ["message", "error"]);
    if (message) return oneLine(message, 240);
  }
  for (const candidate of [result.output, result.content, result.result]) {
    if (candidate === result || typeof candidate === "boolean") continue;
    const nested = taskOutputFailureMessage(candidate, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Prefer the runtime's compact `display` metadata; fall back to the raw
 * `{retrieval_status, task}` result or the persisted model-content string.
 * Restored parts arrive as `{output, display}` and live results as
 * `{success, content, display}` — in both the raw field can embed a full
 * subagent transcript, so it must never be rendered directly. When a restored
 * part carries no display metadata at all, `upsertProtocolPart` passes the
 * persisted `state.output` string through as the whole result.
 */
export function taskOutputDisplay(result: unknown): TaskOutputDisplay | undefined {
  if (typeof result === "string") return taskOutputDisplayFromString(result);
  const record = isRecord(result) ? result : undefined;
  if (!record) return undefined;
  const display = isRecord(record.display)
    ? record.display
    : isRecord(record.resultDisplay) ? record.resultDisplay : undefined;
  if (display && (recordString(display, ["kind"]) === "task_output" || recordString(display, ["retrievalStatus", "retrieval_status"]))) {
    const compact = compactTaskOutput(display.output);
    return {
      retrievalStatus: recordString(display, ["retrievalStatus", "retrieval_status"]),
      taskStatus: recordString(display, ["taskStatus", "task_status", "status"]),
      output: compact.output,
      truncated: booleanField(display, ["truncated"]) === true || compact.truncated,
      source: "display"
    };
  }
  const nested = taskOutputDisplayFromTask(record);
  if (nested) return nested;
  for (const candidate of [record.output, record.content]) {
    if (typeof candidate !== "string") continue;
    const fallback = taskOutputDisplayFromString(candidate);
    if (fallback) return fallback;
  }
  return undefined;
}

export function taskOutputRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const input = isRecord(options.input) ? options.input : undefined;
  const taskId = recordString(input, ["task_id", "taskId", "taskID"]);
  const display = taskOutputDisplay(options.result);
  const body: string[] = [];
  const status = display ? compactStatusLine([
    display.retrievalStatus ? retrievalStatusLabels[display.retrievalStatus] ?? display.retrievalStatus.replaceAll("_", " ") : undefined,
    display.taskStatus && display.taskStatus !== display.retrievalStatus ? display.taskStatus.replaceAll("_", " ") : undefined,
    display.truncated ? "output truncated" : undefined
  ], options.theme) : undefined;
  if (status) body.push(status);
  if (display?.source === "display" && display.output?.trim()) {
    body.push(display.output.trimEnd());
  } else if (display?.retrievalStatus === "not_ready" || display?.retrievalStatus === "timeout") {
    body.push(options.theme.muted("No output yet — check again with TaskOutput or /tasks."));
  } else {
    const failureMessage = taskOutputFailureMessage(options.result);
    body.push(failureMessage ?? options.theme.muted("Task output is available in /tasks."));
  }
  return {
    displayName: "TaskOutput",
    summary: taskId ? `task ${taskId}` : toolSummary(options.name, options.input),
    body: body.join("\n") || undefined,
    consumesResult: true
  };
}
