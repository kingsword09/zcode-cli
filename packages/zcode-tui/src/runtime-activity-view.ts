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
import {
  sanitizeTerminalText,
  truncateGraphemes,
  wrapTerminalText
} from "./terminal-text.ts";
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

function oneLine(value: string, limit?: number): string {
  const normalized = sanitizeTerminalText(value, { preserveSgr: false }).replace(/\s+/gu, " ").trim();
  return limit === undefined ? normalized : truncateGraphemes(normalized, limit);
}

function toolLine(tool: RuntimeActiveToolCall, theme: ZCodeTheme, now: number, expanded: boolean): string {
  const icon = tool.status === "running" ? theme.accent("●") : theme.muted("○");
  const timing = elapsed(tool.startedAt, now);
  return `  ${icon} ${theme.bold(oneLine(tool.toolName, expanded ? undefined : 50))}${timing ? theme.muted(` · ${timing}`) : ""}`;
}

function backgroundLine(job: RuntimeBackgroundJob, theme: ZCodeTheme, now: number, expanded: boolean): string {
  const icon = job.blocked ? theme.warning("◆") : theme.accent("●");
  const label = oneLine(job.description ?? job.command ?? job.toolName ?? job.taskId, expanded ? undefined : 90);
  const details = [
    oneLine(job.taskId),
    job.blocked ? oneLine(job.blockedReason ?? "blocked") : elapsed(job.startedAt, now),
    job.cancelRequestedAt !== undefined ? "cancelling" : undefined
  ].filter(Boolean).join(" · ");
  return `  ${icon} ${theme.bold(label)}${details ? theme.muted(` · ${details}`) : ""}`;
}

function todoLine(todo: RuntimeTodo, theme: ZCodeTheme, expanded: boolean): string {
  const content = oneLine(todo.content, expanded ? undefined : 100);
  if (todo.status === "completed") return `  ${theme.success("✓")} ${theme.muted(content)}`;
  if (todo.status === "in_progress") return `  ${theme.accent("●")} ${theme.bold(content)}`;
  const priority = todo.priority === "high" ? theme.warning("!") : theme.muted("○");
  return `  ${priority} ${theme.muted(content)}`;
}

export class RuntimeActivityView implements Component {
  private state: RuntimeActivityState = { todos: [] };
  private now = Date.now();

  constructor(
    private readonly theme: ZCodeTheme,
    private readonly expanded = false
  ) {}

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
      ...tools.map((tool) => toolLine(tool, this.theme, this.now, this.expanded)),
      ...background.map((job) => backgroundLine(job, this.theme, this.now, this.expanded))
    ];
    const visibleActivities = this.expanded ? activities : activities.slice(0, maxVisibleActivities);
    lines.push(...visibleActivities);
    if (!this.expanded && activities.length > maxVisibleActivities) {
      lines.push(this.theme.muted(`  … ${activities.length - maxVisibleActivities} more activities · /activity`));
    }

    const visibleTodos = unresolvedTodos
      .sort((left, right) => {
        if (left.status !== right.status) return left.status === "in_progress" ? -1 : 1;
        const priority = { high: 0, medium: 1, low: 2 } as const;
        return priority[left.priority] - priority[right.priority];
      })
      .slice(0, this.expanded ? undefined : maxVisibleTodos);
    if (visibleTodos.length > 0) {
      if (activities.length > 0) lines.push("");
      lines.push(...visibleTodos.map((todo) => todoLine(todo, this.theme, this.expanded)));
      if (!this.expanded && unresolvedTodos.length > visibleTodos.length) {
        lines.push(this.theme.muted(`  … ${unresolvedTodos.length - visibleTodos.length} more tasks · /activity`));
      }
    }
    const safeWidth = Math.max(1, width);
    const rendered = this.expanded
      ? lines.flatMap((line) => wrapTerminalText(line, safeWidth))
      : lines.map((line) => truncateToWidth(line, safeWidth));
    return [...rendered, ""];
  }
}
