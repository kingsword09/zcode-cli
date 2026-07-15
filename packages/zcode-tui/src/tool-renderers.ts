import type { ZCodeTheme } from "./theme.ts";
import { sanitizeTerminalText, truncateGraphemes } from "./terminal-text.ts";
import { asString, isRecord } from "./types.ts";

export interface ToolProgressData {
  elapsedMs?: number;
  durationMs?: number;
  pid?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputBytes?: number;
  stdoutTail?: string;
  stderrTail?: string;
  description?: string;
  progress?: number;
  total?: number;
  progressMessage?: string;
  parentToolCallId?: string;
  agentId?: string;
  agentType?: string;
  childSessionId?: string;
  childToolCallId?: string;
  totalToolUseCount?: number;
  totalTokens?: number;
  outputFile?: string;
  backgroundTaskId?: string;
}

export interface SpecializedToolRenderOptions {
  name: string;
  state: string;
  input: unknown;
  result: unknown;
  progress?: ToolProgressData;
  expanded: boolean;
  theme: ZCodeTheme;
}

export interface SpecializedToolRenderResult {
  displayName?: string;
  summary?: string;
  body?: string;
  consumesResult?: boolean;
  hiddenContent?: boolean;
}

export const officialToolNames = [
  "Read",
  "Write",
  "Edit",
  "ApplyPatch",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "TodoWrite",
  "GoalRead",
  "ReadSessionContext",
  "AskUserQuestion",
  "SendMessage",
  "TaskStop",
  "Agent",
  "Task",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode"
] as const;

export type OfficialToolName = typeof officialToolNames[number];
export type CanonicalToolName = OfficialToolName | "MCP";

type ToolRenderer = (options: SpecializedToolRenderOptions) => SpecializedToolRenderResult;

export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

const canonicalAliases = new Map<string, OfficialToolName>([
  ["read", "Read"],
  ["fileread", "Read"],
  ["write", "Write"],
  ["filewrite", "Write"],
  ["edit", "Edit"],
  ["fileedit", "Edit"],
  ["applypatch", "ApplyPatch"],
  ["patch", "ApplyPatch"],
  ["bash", "Bash"],
  ["shell", "Bash"],
  ["exec", "Bash"],
  ["glob", "Glob"],
  ["find", "Glob"],
  ["grep", "Grep"],
  ["searchtext", "Grep"],
  ["webfetch", "WebFetch"],
  ["fetch", "WebFetch"],
  ["websearch", "WebSearch"],
  ["todoread", "TodoRead"],
  ["todowrite", "TodoWrite"],
  ["goalread", "GoalRead"],
  ["readsessioncontext", "ReadSessionContext"],
  ["askuserquestion", "AskUserQuestion"],
  ["sendmessage", "SendMessage"],
  ["taskstop", "TaskStop"],
  ["killshell", "TaskStop"],
  ["killbash", "TaskStop"],
  ["agent", "Agent"],
  ["subagent", "Agent"],
  ["task", "Task"],
  ["skill", "Skill"],
  ["enterplanmode", "EnterPlanMode"],
  ["exitplanmode", "ExitPlanMode"],
  ["exitplanmodev2", "ExitPlanMode"]
]);

function isMcpToolName(name: string): boolean {
  return /^(?:mcp__|mcp[:./])/iu.test(name.trim());
}

export function canonicalToolName(name: string): CanonicalToolName | undefined {
  return canonicalAliases.get(normalizeToolName(name)) ?? (isMcpToolName(name) ? "MCP" : undefined);
}

export function isKnownTool(name: string): boolean {
  return canonicalToolName(name) !== undefined;
}

export function recordString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = asString(record[key]);
    if (value?.trim()) return sanitizeTerminalText(value, { preserveSgr: false }).trim();
  }
  return undefined;
}

export function oneLine(value: string, limit = 100): string {
  const compact = sanitizeTerminalText(value, { preserveSgr: false }).replace(/\s+/gu, " ").trim();
  return truncateGraphemes(compact, limit);
}

function quoted(value: string): string {
  return value.includes(" ") ? JSON.stringify(value) : value;
}

function nestedRecord(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!isRecord(value) || depth > 5) return undefined;
  for (const candidate of [value.output, value.result, value.value, value.data]) {
    if (isRecord(candidate)) return nestedRecord(candidate, depth + 1) ?? candidate;
  }
  return value;
}

function numberField(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function booleanField(record: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function directText(value: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (typeof value === "string") return sanitizeTerminalText(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => directText(item, depth + 1)).filter((item): item is string => Boolean(item)).join("\n");
    return text || undefined;
  }
  if (!isRecord(value)) return undefined;
  if (asString(value.type)?.toLowerCase() === "text") {
    return directText(value.text ?? value.content, depth + 1);
  }
  if (Array.isArray(value.content)) {
    const content = directText(value.content, depth + 1);
    if (content) return content;
  }
  for (const key of ["stdout", "output", "text", "message", "response", "content", "result", "value", "data"]) {
    const candidate: unknown = value[key];
    if (candidate === undefined || candidate === value) continue;
    const text = directText(candidate, depth + 1);
    if (text?.trim()) return text;
  }
  return undefined;
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return sanitizeTerminalText(String(value), { preserveSgr: false });
  }
}

function formatElapsed(milliseconds?: number): string | undefined {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
}

function formatBytes(bytes?: number): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1_024) return `${Math.floor(bytes)} B`;
  if (bytes < 1_048_576) return `${Number((bytes / 1_024).toFixed(1))} KB`;
  return `${Number((bytes / 1_048_576).toFixed(1))} MB`;
}

function displayNameForMcp(name: string): string {
  const parts = name.trim().replace(/^mcp(?:__|[:./])/iu, "").split(/__|[:./]/u).filter(Boolean);
  return parts.length > 0 ? `MCP · ${parts.join("/")}` : "MCP";
}

function inputKeyValueSummary(input: unknown, limit = 3): string | undefined {
  if (!isRecord(input)) return undefined;
  const entries = Object.entries(input).slice(0, limit).map(([key, value]) => {
    const rendered = typeof value === "string" ? value : safeJson(value);
    return rendered ? `${key}=${oneLine(rendered, 48)}` : undefined;
  }).filter((value): value is string => Boolean(value));
  return entries.join(" · ") || undefined;
}

export function toolSummary(name: string, input: unknown): string | undefined {
  const record = isRecord(input) ? input : undefined;
  const canonical = canonicalToolName(name);
  const path = recordString(record, ["file_path", "filePath", "path"]);

  switch (canonical) {
    case "Bash": {
      const command = recordString(record, ["command", "cmd", "script"]);
      return command ? oneLine(command) : undefined;
    }
    case "Glob":
    case "Grep": {
      const pattern = recordString(record, ["pattern", "query", "regex"]);
      return [pattern && quoted(oneLine(pattern, 60)), path && `in ${path}`].filter(Boolean).join(" ") || undefined;
    }
    case "WebFetch":
      return recordString(record, ["url", "uri"]);
    case "WebSearch":
      return recordString(record, ["query", "q"]);
    case "Skill":
      return recordString(record, ["skill", "name"]);
    case "SendMessage": {
      const recipient = recordString(record, ["to", "recipient", "target"]);
      const summary = recordString(record, ["summary"]);
      return [recipient && `to ${recipient}`, summary && oneLine(summary, 60)].filter(Boolean).join(" · ") || undefined;
    }
    case "TaskStop": {
      const task = recordString(record, ["task_id", "taskId", "shell_id", "shellId"]);
      return task ? `task ${task}` : undefined;
    }
    case "Agent":
    case "Task":
      return recordString(record, ["description", "task", "prompt", "subagent_type"]);
    case "ReadSessionContext": {
      const session = recordString(record, ["sessionId", "session_id"]);
      const query = recordString(record, ["query"]);
      return [session, query && oneLine(query, 60)].filter(Boolean).join(" · ") || undefined;
    }
    case "AskUserQuestion": {
      const count = Array.isArray(record?.questions) ? record.questions.length : 0;
      return count > 0 ? `${count} ${count === 1 ? "question" : "questions"}` : undefined;
    }
    case "GoalRead":
    case "TodoRead":
      return undefined;
    case "MCP":
      return inputKeyValueSummary(input);
    default:
      if (path) return path;
      return recordString(record, ["name", "id", "target"]);
  }
}

export function isGroupedInformationTool(name: string): boolean {
  const canonical = canonicalToolName(name);
  return canonical === "Read" || canonical === "Glob" || canonical === "Grep";
}

export function toolGroupKind(name: string): "read" | "search" | undefined {
  const canonical = canonicalToolName(name);
  if (canonical === "Read") return "read";
  if (canonical === "Glob" || canonical === "Grep") return "search";
  return undefined;
}

function compactStatusLine(values: Array<string | undefined>, theme: ZCodeTheme): string | undefined {
  const status = values.filter((value): value is string => Boolean(value)).join(" · ");
  return status ? theme.muted(`└ ${status}`) : undefined;
}

function bashRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
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

function readRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const raw = directText(options.result);
  const count = numberField(record, ["numLines", "lineCount", "count", "numPages", "pageCount"])
    ?? (raw ? raw.replace(/\r/g, "").split("\n").length : undefined);
  const type = recordString(record, ["type", "kind"]);
  const unit = type?.includes("pdf") || record?.numPages !== undefined || record?.pageCount !== undefined
    ? "pages"
    : type?.includes("image")
      ? "image"
      : "lines";
  const status = count !== undefined
    ? `Read ${count} ${count === 1 ? unit.replace(/s$/u, "") : unit}`
    : type?.includes("image")
      ? "Read image"
      : undefined;
  return {
    displayName: "Read",
    summary: toolSummary(options.name, options.input),
    body: options.expanded && raw
      ? [status && options.theme.muted(status), raw].filter(Boolean).join("\n")
      : status && options.theme.muted(status),
    consumesResult: true,
    hiddenContent: Boolean(raw) && !options.expanded
  };
}

function searchRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const amount = numberField(record, ["numMatches", "numFiles", "numLines", "count"]);
  const label = record?.numFiles !== undefined ? "files" : record?.numLines !== undefined ? "lines" : "matches";
  const duration = numberField(record, ["durationMs", "duration"]);
  const status = [
    amount !== undefined ? `Found ${amount} ${amount === 1 ? label.replace(/s$/u, "") : label}` : undefined,
    formatElapsed(duration),
    booleanField(record, ["truncated"]) ? "truncated" : undefined
  ].filter(Boolean).join(" · ");
  const filenames = Array.isArray(record?.filenames)
    ? record.filenames.filter((item): item is string => typeof item === "string").join("\n")
    : undefined;
  const content = recordString(record, ["content", "output", "text"]) ?? filenames ?? directText(options.result);
  return {
    displayName: canonicalToolName(options.name) === "Glob" ? "Glob" : "Grep",
    summary: toolSummary(options.name, options.input),
    body: options.expanded && content
      ? [status && options.theme.muted(status), content].filter(Boolean).join("\n")
      : status && options.theme.muted(status),
    consumesResult: true,
    hiddenContent: Boolean(content) && !options.expanded
  };
}

function mutationRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  return {
    displayName: canonicalToolName(options.name),
    summary: toolSummary(options.name, options.input)
  };
}

function webFetchRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const content = recordString(record, ["result", "content", "text"]);
  const status = numberField(record, ["status", "statusCode", "code"]);
  const statusText = recordString(record, ["statusText", "codeText"]);
  const details = [
    numberField(record, ["bytes"]) !== undefined ? `Received ${formatBytes(numberField(record, ["bytes"]))}` : undefined,
    status !== undefined ? `${status}${statusText ? ` ${statusText}` : ""}` : undefined,
    formatElapsed(numberField(record, ["durationMs", "duration"])),
    booleanField(record, ["cacheHit"]) ? "cache hit" : undefined,
    booleanField(record, ["truncated"]) ? "truncated" : undefined
  ].filter(Boolean).join(" · ");
  const redirects = Array.isArray(record?.redirects) ? record.redirects.length : 0;
  const finalUrl = recordString(record, ["finalUrl"]);
  const metadata = [
    details && options.theme.muted(`└ ${details}`),
    redirects > 0 && options.theme.muted(`${redirects} ${redirects === 1 ? "redirect" : "redirects"}${finalUrl ? ` · ${finalUrl}` : ""}`)
  ].filter(Boolean);
  return {
    displayName: "Fetch",
    summary: toolSummary(options.name, options.input),
    body: [...metadata, ...(options.expanded && content ? [content] : [])].join("\n") || undefined,
    consumesResult: Boolean(record || content),
    hiddenContent: Boolean(content) && !options.expanded
  };
}

function linkRows(record: Record<string, unknown> | undefined): string[] {
  if (!record) return [];
  const rows: string[] = [];
  for (const key of ["results", "sources"] as const) {
    const values = record[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (!isRecord(value)) continue;
      const url = recordString(value, ["url", "uri"]);
      if (!url || rows.some((row) => row.endsWith(url))) continue;
      const title = recordString(value, ["title", "name"]);
      const age = recordString(value, ["pageAge", "age"]);
      rows.push(`${title ? `${title} · ` : ""}${url}${age ? ` · ${age}` : ""}`);
    }
  }
  return rows;
}

function webSearchRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const results = Array.isArray(record?.results) ? record.results.length : 0;
  const sources = Array.isArray(record?.sources) ? record.sources.length : 0;
  const requests = numberField(record, ["webSearchRequests", "searchCount"]);
  const duration = numberField(record, ["durationMs", "duration"]);
  const summaryText = recordString(record, ["summary"]);
  const rows = linkRows(record);
  const details = [
    `${results} ${results === 1 ? "result" : "results"}`,
    sources > 0 ? `${sources} ${sources === 1 ? "source" : "sources"}` : undefined,
    requests !== undefined ? `${requests} ${requests === 1 ? "search" : "searches"}` : undefined,
    formatElapsed(duration)
  ].filter(Boolean).join(" · ");
  const expanded = [summaryText, ...rows].filter(Boolean).join("\n");
  return {
    displayName: "Web search",
    summary: toolSummary(options.name, options.input),
    body: [options.theme.muted(`└ ${details}`), options.expanded && expanded ? expanded : undefined].filter(Boolean).join("\n"),
    consumesResult: Boolean(record),
    hiddenContent: Boolean(expanded) && !options.expanded
  };
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: string;
}

function todoItems(value: unknown): TodoItem[] {
  const record = nestedRecord(value);
  if (!Array.isArray(record?.todos)) return [];
  return record.todos.flatMap((item): TodoItem[] => {
    if (!isRecord(item)) return [];
    const content = recordString(item, ["content"]);
    const status = recordString(item, ["status"]);
    if (!content || (status !== "pending" && status !== "in_progress" && status !== "completed")) return [];
    return [{ content, status, priority: recordString(item, ["priority"]) }];
  });
}

function todoReadRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const todos = todoItems(options.result);
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.filter((todo) => todo.status === "in_progress").length;
  const pending = todos.length - completed - active;
  const visible = options.expanded ? todos : todos.slice(0, 12);
  const lines = visible.map((todo) => {
    if (todo.status === "completed") return `${options.theme.success("✓")} ${options.theme.muted(todo.content)}`;
    if (todo.status === "in_progress") return `${options.theme.accent("□")} ${options.theme.bold(todo.content)}`;
    return `${options.theme.muted("□")} ${options.theme.muted(todo.content)}`;
  });
  if (todos.length > visible.length) lines.push(options.theme.muted(`… ${todos.length - visible.length} more items`));
  return {
    displayName: "Todo list",
    body: todos.length > 0
      ? [options.theme.muted(`└ ${completed} completed · ${active} in progress · ${pending} pending`), ...lines].join("\n")
      : options.theme.muted("No todos"),
    consumesResult: true,
    hiddenContent: todos.length > visible.length
  };
}

function goalReadRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const objective = recordString(record, ["objective", "goal", "target", "content"]);
  const status = recordString(record, ["status"]);
  const tokensUsed = numberField(record, ["tokensUsed", "tokens_used"]);
  const tokenBudget = numberField(record, ["tokenBudget", "token_budget"]);
  const timeSeconds = numberField(record, ["timeUsedSeconds", "time_used_seconds"]);
  const details = [
    status,
    tokensUsed !== undefined ? `${tokensUsed.toLocaleString()} tokens used` : undefined,
    tokenBudget !== undefined ? `${tokenBudget.toLocaleString()} budget` : undefined,
    timeSeconds !== undefined ? formatElapsed(timeSeconds * 1_000) : undefined
  ].filter(Boolean).join(" · ");
  const raw = directText(options.result);
  const body = objective ?? (raw && raw !== safeJson(record) ? raw : undefined);
  return {
    displayName: "Goal",
    summary: objective ? oneLine(objective, 90) : status,
    body: [details && options.theme.muted(`└ ${details}`), options.expanded && body ? body : undefined].filter(Boolean).join("\n") || undefined,
    consumesResult: Boolean(record || raw),
    hiddenContent: Boolean(body) && !options.expanded
  };
}

function sessionContextRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const content = recordString(record, ["content"]);
  const status = recordString(record, ["status"]);
  const sessionId = recordString(record, ["sessionId", "session_id"])
    ?? recordString(isRecord(options.input) ? options.input : undefined, ["sessionId", "session_id"]);
  const source = recordString(record, ["source"]);
  const selected = numberField(record, ["selectedMessageCount"]);
  const total = numberField(record, ["messageCount"]);
  const details = [
    status,
    source && `${source} source`,
    selected !== undefined && total !== undefined ? `${selected}/${total} messages` : total !== undefined ? `${total} messages` : undefined,
    booleanField(record, ["truncated"]) ? "truncated" : undefined
  ].filter(Boolean).join(" · ");
  return {
    displayName: "Session context",
    summary: sessionId,
    body: [details && options.theme.muted(`└ ${details}`), options.expanded && content ? content : undefined].filter(Boolean).join("\n") || undefined,
    consumesResult: Boolean(record),
    hiddenContent: Boolean(content) && !options.expanded
  };
}

function questionRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const input = isRecord(options.input) ? options.input : undefined;
  const result = nestedRecord(options.result);
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const answers = isRecord(result?.answers) ? result.answers : undefined;
  const lines: string[] = [];
  if (answers) {
    for (const [question, answer] of Object.entries(answers)) {
      const rendered = asString(answer) ?? safeJson(answer);
      if (rendered) lines.push(`${options.theme.muted(oneLine(question, 72))}\n${options.theme.accent(`  ${oneLine(rendered, 100)}`)}`);
    }
  } else if (questions.length > 0 && options.state.toLowerCase() === "waiting_permission") {
    lines.push(options.theme.muted(`Awaiting ${questions.length} ${questions.length === 1 ? "answer" : "answers"}`));
  }
  return {
    displayName: "Question",
    summary: toolSummary(options.name, options.input),
    body: lines.join("\n") || undefined,
    consumesResult: Boolean(result)
  };
}

function sendMessageRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const input = isRecord(options.input) ? options.input : undefined;
  const result = nestedRecord(options.result);
  const delivery = recordString(result, ["delivery"]);
  const status = recordString(result, ["status"]);
  const messageId = recordString(result, ["messageId", "message_id"]);
  const message = recordString(result, ["message", "error"]);
  const fullMessage = recordString(input, ["message"]);
  const details = [status, delivery, messageId && `id ${messageId}`].filter(Boolean).join(" · ");
  return {
    displayName: "Message",
    summary: toolSummary(options.name, options.input),
    body: [details && options.theme.muted(`└ ${details}`), message, options.expanded && fullMessage ? fullMessage : undefined].filter(Boolean).join("\n") || undefined,
    consumesResult: Boolean(result),
    hiddenContent: Boolean(fullMessage) && !options.expanded
  };
}

function taskStopRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
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

function agentRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
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

function skillRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const raw = directText(options.result);
  const name = recordString(record, ["name"])
    ?? recordString(isRecord(options.input) ? options.input : undefined, ["skill", "name"]);
  const baseDirectory = recordString(record, ["baseDirectory"]);
  const truncated = booleanField(record, ["truncated"]);
  const content = recordString(record, ["content"]) ?? raw;
  const details = [baseDirectory, truncated ? "truncated" : undefined].filter(Boolean).join(" · ");
  return {
    displayName: "Skill",
    summary: name,
    body: [options.theme.muted(`└ Loaded${details ? ` · ${details}` : ""}`), options.expanded && content ? content : undefined].filter(Boolean).join("\n"),
    consumesResult: Boolean(record || raw),
    hiddenContent: Boolean(content) && !options.expanded
  };
}

function planModeRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const canonical = canonicalToolName(options.name);
  const record = nestedRecord(options.result);
  const message = recordString(record, ["message"]);
  const mode = recordString(record, ["mode"]);
  const approved = booleanField(record, ["approved"]);
  const plan = recordString(record, ["plan"])
    ?? recordString(isRecord(options.input) ? options.input : undefined, ["plan"]);
  return {
    displayName: canonical === "EnterPlanMode" ? "Plan mode" : "Plan approval",
    summary: canonical === "EnterPlanMode" ? "enter" : approved ? "approved" : undefined,
    body: [message, mode && options.theme.muted(`Mode: ${mode}`), options.expanded && plan ? plan : undefined].filter(Boolean).join("\n") || undefined,
    consumesResult: Boolean(record),
    hiddenContent: Boolean(plan) && !options.expanded
  };
}

function mcpRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const raw = directText(options.result);
  const progress = options.progress?.progress;
  const total = options.progress?.total;
  const progressLine = progress !== undefined && total !== undefined && total > 0
    ? `${options.progress?.progressMessage ? `${options.progress.progressMessage} · ` : ""}${Math.round(Math.min(1, progress / total) * 100)}%`
    : options.progress?.progressMessage ?? options.progress?.description;
  let content = raw;
  if (!content && record) {
    const entries = Object.entries(record);
    const flat = entries.length > 0 && entries.length <= 12 && entries.every(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value));
    content = flat
      ? entries.map(([key, value]) => `${key.padEnd(Math.max(...entries.map(([name]) => name.length)))}: ${String(value)}`).join("\n")
      : safeJson(record);
  }
  const estimatedTokens = content ? Math.ceil(content.length / 4) : 0;
  const warnings = estimatedTokens > 10_000 ? options.theme.warning(`Large MCP response (~${estimatedTokens.toLocaleString()} tokens)`) : undefined;
  return {
    displayName: displayNameForMcp(options.name),
    summary: toolSummary(options.name, options.input),
    body: [progressLine && options.theme.muted(`└ ${progressLine}`), warnings, content].filter(Boolean).join("\n") || undefined,
    consumesResult: Boolean(content)
  };
}

const rendererRegistry: Record<OfficialToolName, ToolRenderer> = {
  Read: readRender,
  Write: mutationRender,
  Edit: mutationRender,
  ApplyPatch: mutationRender,
  Bash: bashRender,
  Glob: searchRender,
  Grep: searchRender,
  WebFetch: webFetchRender,
  WebSearch: webSearchRender,
  TodoRead: todoReadRender,
  TodoWrite: (options) => ({ displayName: "Plan", summary: toolSummary(options.name, options.input) }),
  GoalRead: goalReadRender,
  ReadSessionContext: sessionContextRender,
  AskUserQuestion: questionRender,
  SendMessage: sendMessageRender,
  TaskStop: taskStopRender,
  Agent: agentRender,
  Task: agentRender,
  Skill: skillRender,
  EnterPlanMode: planModeRender,
  ExitPlanMode: planModeRender
};

export function specializedToolRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult | undefined {
  const canonical = canonicalToolName(options.name);
  if (!canonical) return undefined;
  return canonical === "MCP" ? mcpRender(options) : rendererRegistry[canonical](options);
}
