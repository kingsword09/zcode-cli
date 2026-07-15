import { isRecord } from "../types.ts";
import type { SpecializedToolRenderOptions, SpecializedToolRenderResult } from "./types.ts";
import {
  booleanField,
  directText,
  formatElapsed,
  nestedRecord,
  numberField,
  oneLine,
  recordString,
  safeJson
} from "./helpers.ts";
import { canonicalToolName } from "./registry.ts";

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

export function todoReadRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
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

export function goalReadRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
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

export function sessionContextRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
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

export function planModeRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
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
