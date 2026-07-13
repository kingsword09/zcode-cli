import { asString, isRecord } from "./types.ts";

export type RuntimeToolStatus = "pending" | "running" | "completed" | "failed" | "denied";
export type RuntimeBackgroundStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

export interface RuntimeTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

export interface RuntimeTodoGroup {
  id: string;
  source: "goal_iteration" | "session";
  goalIteration?: number;
  targetId?: string;
  startedAt?: number;
  updatedAt?: number;
  todos: RuntimeTodo[];
}

export interface RuntimeActiveToolCall {
  toolCallId: string;
  toolName: string;
  status: RuntimeToolStatus;
  startedAt?: number;
}

export interface RuntimeBackgroundJob {
  taskId: string;
  toolCallId?: string;
  toolName?: string;
  blocked?: boolean;
  blockedReason?: string;
  cancellable?: boolean;
  cancelRequestedAt?: number;
  command?: string;
  description?: string;
  status: RuntimeBackgroundStatus;
  pid?: number;
  startedAt?: number;
  completedAt?: number;
  outputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  outputTail?: string;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  terminalId?: string;
}

export interface RuntimeContextBreakdownItem {
  source:
    | "system_prompt"
    | "meta_user_context"
    | "skills"
    | "tool_prompt"
    | "system_tool_schemas"
    | "mcp_tool_schemas"
    | "messages";
  chars: number;
}

export interface RuntimeContextUsage {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
  cache?: {
    inputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    latestHitRate?: number | null;
    hitRate?: number | null;
    hitRateRequestCount?: number;
    totalInputTokens?: number;
    totalCacheReadTokens?: number;
    totalCacheWriteTokens?: number;
  };
  breakdown: RuntimeContextBreakdownItem[];
}

export interface RuntimeProjectionSnapshot {
  sessionId?: string;
  status?: string;
  mode?: string;
  turnCount?: number;
  totalTokenCount?: number;
  currentTurnId?: string;
  activeToolCalls: RuntimeActiveToolCall[];
  backgroundJobs: RuntimeBackgroundJob[];
  contextUsage?: RuntimeContextUsage;
  lastError?: {
    type: string;
    code?: string;
    message: string;
    detail?: string;
  };
}

const toolStatuses = new Set<RuntimeToolStatus>(["pending", "running", "completed", "failed", "denied"]);
const backgroundStatuses = new Set<RuntimeBackgroundStatus>([
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_error",
  "lost"
]);
const todoStatuses = new Set<RuntimeTodo["status"]>(["pending", "in_progress", "completed"]);
const todoPriorities = new Set<RuntimeTodo["priority"]>(["high", "medium", "low"]);
const contextSources = new Set<RuntimeContextBreakdownItem["source"]>([
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "messages"
]);

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? Math.floor(number) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = nonNegativeInteger(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  const number = finiteNumber(value);
  if (number !== undefined) return number;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const field = asString(value[key])?.trim();
    if (field) return field;
  }
  return undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function todoFrom(value: unknown): RuntimeTodo | undefined {
  if (!isRecord(value)) return undefined;
  const content = stringField(value, "content");
  const status = stringField(value, "status") as RuntimeTodo["status"] | undefined;
  const priority = stringField(value, "priority") as RuntimeTodo["priority"] | undefined;
  if (!content || !status || !todoStatuses.has(status)) return undefined;
  return {
    content,
    status,
    priority: priority && todoPriorities.has(priority) ? priority : "medium"
  };
}

export function normalizeTodos(value: unknown): RuntimeTodo[] {
  const source = isRecord(value) && Array.isArray(value.todos) ? value.todos : value;
  return (Array.isArray(source) ? source : []).flatMap((item): RuntimeTodo[] => {
    const todo = todoFrom(item);
    return todo ? [todo] : [];
  });
}

export function normalizeTodoGroups(value: unknown): RuntimeTodoGroup[] {
  const source = isRecord(value) ? value.todoGroups : undefined;
  return records(source).flatMap((group): RuntimeTodoGroup[] => {
    const id = stringField(group, "id");
    const sourceKind = stringField(group, "source");
    if (!id || (sourceKind !== "goal_iteration" && sourceKind !== "session")) return [];
    return [{
      id,
      source: sourceKind,
      goalIteration: positiveInteger(group.goalIteration),
      targetId: stringField(group, "targetId", "targetID"),
      startedAt: timestamp(group.startedAt),
      updatedAt: timestamp(group.updatedAt),
      todos: normalizeTodos(group.todos)
    }];
  });
}

function activeToolFrom(value: unknown): RuntimeActiveToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const toolCallId = stringField(value, "toolCallId", "toolCallID", "id");
  const toolName = stringField(value, "toolName", "name");
  const status = stringField(value, "status") as RuntimeToolStatus | undefined;
  if (!toolCallId || !toolName || !status || !toolStatuses.has(status)) return undefined;
  return { toolCallId, toolName, status, startedAt: timestamp(value.startedAt) };
}

function backgroundJobFrom(value: unknown): RuntimeBackgroundJob | undefined {
  if (!isRecord(value)) return undefined;
  const taskId = stringField(value, "taskId", "taskID", "id");
  const status = stringField(value, "status") as RuntimeBackgroundStatus | undefined;
  if (!taskId || !status || !backgroundStatuses.has(status)) return undefined;
  return {
    taskId,
    toolCallId: stringField(value, "toolCallId", "toolCallID"),
    toolName: stringField(value, "toolName"),
    blocked: typeof value.blocked === "boolean" ? value.blocked : undefined,
    blockedReason: stringField(value, "blockedReason"),
    cancellable: typeof value.cancellable === "boolean" ? value.cancellable : undefined,
    cancelRequestedAt: timestamp(value.cancelRequestedAt),
    command: stringField(value, "command"),
    description: stringField(value, "description"),
    status,
    pid: positiveInteger(value.pid),
    startedAt: timestamp(value.startedAt),
    completedAt: timestamp(value.completedAt),
    outputPath: stringField(value, "outputPath"),
    outputBytes: nonNegativeInteger(value.outputBytes),
    outputTruncated: typeof value.outputTruncated === "boolean" ? value.outputTruncated : undefined,
    outputTail: asString(value.outputTail),
    stderrBytes: nonNegativeInteger(value.stderrBytes),
    stderrTail: asString(value.stderrTail),
    stdoutBytes: nonNegativeInteger(value.stdoutBytes),
    stdoutTail: asString(value.stdoutTail),
    terminalId: stringField(value, "terminalId", "terminalID")
  };
}

function contextBreakdown(value: unknown): RuntimeContextBreakdownItem[] {
  return records(value).flatMap((item): RuntimeContextBreakdownItem[] => {
    const source = stringField(item, "source") as RuntimeContextBreakdownItem["source"] | undefined;
    const chars = nonNegativeInteger(item.chars);
    return source && contextSources.has(source) && chars !== undefined ? [{ source, chars }] : [];
  });
}

function contextUsageFrom(value: unknown, projection: Record<string, unknown>): RuntimeContextUsage | undefined {
  const context = isRecord(value) ? value : undefined;
  const used = nonNegativeInteger(context?.used) ?? nonNegativeInteger(projection.contextUsed);
  const size = positiveInteger(context?.size) ?? positiveInteger(projection.contextWindow);
  if (used === undefined || size === undefined) return undefined;
  const cost = isRecord(context?.cost)
    && finiteNumber(context.cost.amount) !== undefined
    && stringField(context.cost, "currency")
    ? { amount: finiteNumber(context.cost.amount)!, currency: stringField(context.cost, "currency")! }
    : undefined;
  const rawCache = isRecord(context?.cache) ? context.cache : undefined;
  const cache = rawCache ? {
    inputTokens: nonNegativeInteger(rawCache.inputTokens),
    cacheReadTokens: nonNegativeInteger(rawCache.cacheReadTokens),
    cacheWriteTokens: nonNegativeInteger(rawCache.cacheWriteTokens),
    latestHitRate: rawCache.latestHitRate === null ? null : finiteNumber(rawCache.latestHitRate),
    hitRate: rawCache.hitRate === null ? null : finiteNumber(rawCache.hitRate),
    hitRateRequestCount: nonNegativeInteger(rawCache.hitRateRequestCount),
    totalInputTokens: nonNegativeInteger(rawCache.totalInputTokens),
    totalCacheReadTokens: nonNegativeInteger(rawCache.totalCacheReadTokens),
    totalCacheWriteTokens: nonNegativeInteger(rawCache.totalCacheWriteTokens)
  } : undefined;
  return {
    used,
    size,
    cost,
    cache,
    breakdown: contextBreakdown(context?.breakdown)
  };
}

export function normalizeRuntimeProjection(value: unknown): RuntimeProjectionSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const projection = isRecord(value.projection) ? value.projection : value;
  const runtime = isRecord(value.runtime) ? value.runtime : undefined;
  const rawActiveTools = projection.activeToolCalls;
  const rawBackgroundJobs = projection.backgroundJobs ?? projection.backgroundTasks;
  const rawLastError = isRecord(projection.lastError) ? projection.lastError : undefined;
  const lastErrorType = rawLastError && stringField(rawLastError, "type");
  const lastErrorMessage = rawLastError && stringField(rawLastError, "message");
  const snapshot: RuntimeProjectionSnapshot = {
    sessionId: stringField(projection, "sessionId", "sessionID", "id"),
    status: stringField(projection, "status"),
    mode: stringField(projection, "mode"),
    turnCount: nonNegativeInteger(projection.turnCount),
    totalTokenCount: nonNegativeInteger(projection.totalTokenCount),
    currentTurnId: stringField(projection, "currentTurnId", "currentTurnID"),
    activeToolCalls: records(rawActiveTools).flatMap((item): RuntimeActiveToolCall[] => {
      const tool = activeToolFrom(item);
      return tool ? [tool] : [];
    }),
    backgroundJobs: records(rawBackgroundJobs).flatMap((item): RuntimeBackgroundJob[] => {
      const job = backgroundJobFrom(item);
      return job ? [job] : [];
    }),
    contextUsage: contextUsageFrom(runtime?.contextUsage ?? value.contextUsage, projection),
    lastError: lastErrorType && lastErrorMessage ? {
      type: lastErrorType,
      code: stringField(rawLastError!, "code"),
      message: lastErrorMessage,
      detail: stringField(rawLastError!, "detail")
    } : undefined
  };
  return snapshot;
}

export function isActiveRuntimeTool(tool: RuntimeActiveToolCall): boolean {
  return tool.status === "pending" || tool.status === "running";
}

export function isActiveBackgroundJob(job: RuntimeBackgroundJob): boolean {
  return job.status === "running";
}
