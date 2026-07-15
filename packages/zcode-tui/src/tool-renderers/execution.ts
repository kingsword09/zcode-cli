import { sanitizeTerminalText } from "../terminal-text.ts";
import { isRecord } from "../types.ts";
import type { SpecializedToolRenderOptions, SpecializedToolRenderResult } from "./types.ts";
import {
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
