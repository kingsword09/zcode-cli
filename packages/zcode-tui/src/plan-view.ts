import {
  Container,
  Text
} from "@earendil-works/pi-tui";

import { createTheme, type ZCodeTheme } from "./theme.ts";
import { asString, isRecord } from "./types.ts";

const maxVisibleTodos = 20;
const todoStatuses = new Set(["pending", "in_progress", "completed"]);

interface PlanTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PlanUpdateOptions {
  state: string;
  input?: unknown;
  result?: unknown;
  error?: unknown;
}

function todosFrom(value: unknown): PlanTodo[] {
  if (!isRecord(value)) return [];
  if (!Array.isArray(value.todos)) {
    for (const nested of [value.output, value.value]) {
      const todos = todosFrom(nested);
      if (todos.length > 0) return todos;
    }
    return [];
  }

  return value.todos.flatMap((item): PlanTodo[] => {
    if (!isRecord(item)) return [];
    const content = asString(item.content)?.trim();
    const status = asString(item.status);
    if (!content || !status || !todoStatuses.has(status)) return [];
    return [{ content, status: status as PlanTodo["status"] }];
  });
}

function errorMessage(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return isRecord(value) ? asString(value.message) : undefined;
}

function planHeader(state: string, theme: ZCodeTheme): string {
  const normalized = state.toLowerCase();
  if (["failed", "error", "cancelled"].includes(normalized)) {
    return `${theme.error("✗")} ${theme.bold("Plan update failed")}`;
  }
  if (["complete", "completed", "success"].includes(normalized)) {
    return `${theme.muted("●")} ${theme.bold("Updated Plan")}`;
  }
  const phase = normalized === "running" ? "running" : "preparing";
  return `${theme.accent("●")} ${theme.bold("Updating Plan")} ${theme.muted(`· ${phase}`)}`;
}

function planBody(todos: PlanTodo[], state: string, error: unknown, theme: ZCodeTheme): string | undefined {
  const lines: string[] = [];
  if (todos.length > 0) {
    const completed = todos.filter((todo) => todo.status === "completed").length;
    const active = todos.filter((todo) => todo.status === "in_progress").length;
    const pending = todos.length - completed - active;
    lines.push(theme.muted(`└ ${completed} completed · ${active} in progress · ${pending} pending`));

    for (const todo of todos.slice(0, maxVisibleTodos)) {
      if (todo.status === "completed") {
        lines.push(`${theme.success("✓")} ${theme.muted(todo.content)}`);
      } else if (todo.status === "in_progress") {
        lines.push(`${theme.accent("□")} ${theme.accent(theme.bold(todo.content))}`);
      } else {
        lines.push(`${theme.muted("□")} ${theme.muted(todo.content)}`);
      }
    }
    if (todos.length > maxVisibleTodos) {
      lines.push(theme.muted(`… ${todos.length - maxVisibleTodos} more items`));
    }
  }

  if (["failed", "error", "cancelled"].includes(state.toLowerCase())) {
    const message = errorMessage(error);
    if (message) lines.push(theme.error(message));
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function planText(options: PlanUpdateOptions, theme: ZCodeTheme): { header: string; body?: string } {
  const resultTodos = todosFrom(options.result);
  const todos = resultTodos.length > 0 ? resultTodos : todosFrom(options.input);
  return {
    header: planHeader(options.state, theme),
    body: planBody(todos, options.state, options.error, theme)
  };
}

export function isPlanUpdateTool(name: string): boolean {
  return name.toLowerCase().replace(/[^a-z]/gu, "") === "todowrite";
}

export class PlanUpdateView extends Container {
  constructor(theme: ZCodeTheme, options: PlanUpdateOptions) {
    super();
    const rendered = planText(options, theme);
    this.addChild(new Text(rendered.header, 0, 0));
    if (rendered.body) this.addChild(new Text(rendered.body, 1, 0));
  }
}

export function planCard(options: PlanUpdateOptions): string {
  const rendered = planText(options, createTheme(false));
  return [rendered.header, rendered.body].filter(Boolean).join("\n");
}
