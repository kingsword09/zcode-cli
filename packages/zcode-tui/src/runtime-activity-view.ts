import {
  truncateToWidth,
  type Component
} from "@earendil-works/pi-tui";

import {
  isActiveBackgroundJob,
  isActiveRuntimeTool,
  type RuntimeActiveToolCall,
  type RuntimeBackgroundJob,
  type RuntimeProjectionSnapshot,
  type RuntimeTodo,
  type RuntimeTodoGroup
} from "./runtime-projection.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import type { ZCodeTheme } from "./theme.ts";

const maxVisibleTodos = 4;
const maxVisibleActivities = 5;

export interface RuntimeActivityState {
  projection?: RuntimeProjectionSnapshot;
  todos: RuntimeTodo[];
  todoGroups?: RuntimeTodoGroup[];
}

function elapsed(startedAt: number | undefined, now: number): string | undefined {
  if (startedAt === undefined) return undefined;
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function oneLine(value: string, limit = 100): string {
  const normalized = sanitizeTerminalText(value, { preserveSgr: false }).replace(/\s+/gu, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function toolLine(tool: RuntimeActiveToolCall, theme: ZCodeTheme, now: number): string {
  const icon = tool.status === "running" ? theme.accent("●") : theme.muted("○");
  const timing = elapsed(tool.startedAt, now);
  return `  ${icon} ${theme.bold(oneLine(tool.toolName, 50))}${timing ? theme.muted(` · ${timing}`) : ""}`;
}

function backgroundLine(job: RuntimeBackgroundJob, theme: ZCodeTheme, now: number): string {
  const icon = job.blocked ? theme.warning("◆") : theme.accent("●");
  const label = oneLine(job.description ?? job.command ?? job.toolName ?? job.taskId, 90);
  const details = [
    job.taskId,
    job.blocked ? job.blockedReason ?? "blocked" : elapsed(job.startedAt, now),
    job.cancelRequestedAt !== undefined ? "cancelling" : undefined
  ].filter(Boolean).join(" · ");
  return `  ${icon} ${theme.bold(label)}${details ? theme.muted(` · ${details}`) : ""}`;
}

function todoLine(todo: RuntimeTodo, theme: ZCodeTheme): string {
  if (todo.status === "completed") return `  ${theme.success("✓")} ${theme.muted(oneLine(todo.content))}`;
  if (todo.status === "in_progress") return `  ${theme.accent("●")} ${theme.bold(oneLine(todo.content))}`;
  const priority = todo.priority === "high" ? theme.warning("!") : theme.muted("○");
  return `  ${priority} ${theme.muted(oneLine(todo.content))}`;
}

export class RuntimeActivityView implements Component {
  private state: RuntimeActivityState = { todos: [] };
  private now = Date.now();

  constructor(private readonly theme: ZCodeTheme) {}

  update(state: RuntimeActivityState): void {
    this.state = state;
    this.now = Date.now();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const tools = (this.state.projection?.activeToolCalls ?? []).filter(isActiveRuntimeTool);
    const background = (this.state.projection?.backgroundJobs ?? []).filter(isActiveBackgroundJob);
    const unresolvedTodos = this.state.todos.filter((todo) => todo.status !== "completed");
    if (tools.length === 0 && background.length === 0 && unresolvedTodos.length === 0) return [];

    const currentGroup = this.state.todoGroups?.at(-1);
    const summary = [
      tools.length > 0 ? `${tools.length} active ${tools.length === 1 ? "tool" : "tools"}` : undefined,
      background.length > 0 ? `${background.length} in background` : undefined,
      unresolvedTodos.length > 0 ? `${unresolvedTodos.length} open ${unresolvedTodos.length === 1 ? "task" : "tasks"}` : undefined,
      currentGroup?.source === "goal_iteration" && currentGroup.goalIteration
        ? `goal iteration ${currentGroup.goalIteration}`
        : undefined
    ].filter(Boolean).join(" · ");
    const lines = [` ${this.theme.bold("Activity")} ${this.theme.muted(`· ${summary}${background.length > 0 ? " · /tasks" : ""}`)}`];

    const activities = [
      ...tools.map((tool) => toolLine(tool, this.theme, this.now)),
      ...background.map((job) => backgroundLine(job, this.theme, this.now))
    ];
    lines.push(...activities.slice(0, maxVisibleActivities));
    if (activities.length > maxVisibleActivities) {
      lines.push(this.theme.muted(`  … ${activities.length - maxVisibleActivities} more activities`));
    }

    const visibleTodos = unresolvedTodos
      .sort((left, right) => {
        if (left.status !== right.status) return left.status === "in_progress" ? -1 : 1;
        const priority = { high: 0, medium: 1, low: 2 } as const;
        return priority[left.priority] - priority[right.priority];
      })
      .slice(0, maxVisibleTodos);
    if (visibleTodos.length > 0) {
      if (activities.length > 0) lines.push("");
      lines.push(...visibleTodos.map((todo) => todoLine(todo, this.theme)));
      if (unresolvedTodos.length > visibleTodos.length) {
        lines.push(this.theme.muted(`  … ${unresolvedTodos.length - visibleTodos.length} more tasks`));
      }
    }
    return [...lines.map((line) => truncateToWidth(line, Math.max(1, width))), ""];
  }
}
