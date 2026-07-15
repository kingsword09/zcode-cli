import type { ZCodeTheme } from "../theme.ts";
import { sanitizeTerminalText, truncateGraphemes } from "../terminal-text.ts";
import { asString, isRecord } from "../types.ts";
import { canonicalToolName } from "./registry.ts";

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

export function quoted(value: string): string {
  return value.includes(" ") ? JSON.stringify(value) : value;
}

export function nestedRecord(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!isRecord(value) || depth > 5) return undefined;
  for (const candidate of [value.output, value.result, value.value, value.data]) {
    if (isRecord(candidate)) return nestedRecord(candidate, depth + 1) ?? candidate;
  }
  return value;
}

export function numberField(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

export function booleanField(record: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function directText(value: unknown, depth = 0): string | undefined {
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

export function safeJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return sanitizeTerminalText(String(value), { preserveSgr: false });
  }
}

export function formatElapsed(milliseconds?: number): string | undefined {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
}

export function formatBytes(bytes?: number): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1_024) return `${Math.floor(bytes)} B`;
  if (bytes < 1_048_576) return `${Number((bytes / 1_024).toFixed(1))} KB`;
  return `${Number((bytes / 1_048_576).toFixed(1))} MB`;
}

export function compactStatusLine(values: Array<string | undefined>, theme: ZCodeTheme): string | undefined {
  const status = values.filter((value): value is string => Boolean(value)).join(" · ");
  return status ? theme.muted(`└ ${status}`) : undefined;
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
