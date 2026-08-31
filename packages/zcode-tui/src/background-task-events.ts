import type { StreamEvent } from "./events.ts";
import { isAgentDispatchTool } from "./tool-renderers/registry.ts";

export type TaskActivityKind = "assistant" | "error" | "system" | "user";

export interface TaskActivityEntry {
  id: string;
  kind: TaskActivityKind;
  text: string;
  timestamp: number;
  turnId?: string;
}

export interface TaskEventNotice {
  detail?: string;
  notification: "completed" | "failed";
  summary: string;
  title: string;
  tone: "error" | "muted" | "warning";
}

export interface TaskEventUpdate {
  changed: boolean;
  handoffSettled: boolean;
  notices: TaskEventNotice[];
}

interface HandoffTurn {
  source: "background_task" | "subagent_message";
  taskIds: string[];
}

const maximumEntriesPerTask = 32;
const maximumCharactersPerTask = 64_000;
const maximumEntryCharacters = 20_000;
const maximumScopedTurnIds = 256;
const maximumScopedToolCallIds = 512;

function autonomousInputSource(source: string | undefined): source is HandoffTurn["source"] {
  return source === "background_task" || source === "subagent_message";
}

function taskIdFor(event: StreamEvent): string | undefined {
  return event.taskId ?? event.agentId;
}

function terminalTaskStatus(status: string | undefined): boolean {
  return status === "completed"
    || status === "failed"
    || status === "timed_out"
    || status === "cancelled"
    || status === "killed"
    || status === "spawn_error"
    || status === "lost"
    || status === "stopped";
}

function taskFailure(status: string | undefined): boolean {
  return status === "failed"
    || status === "timed_out"
    || status === "spawn_error"
    || status === "lost";
}

function bounded(value: string): string {
  return value.length <= maximumEntryCharacters
    ? value
    : value.slice(0, maximumEntryCharacters) + "\n[truncated]";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function explicitlyBackgroundAgentInput(value: unknown): boolean {
  return record(value)?.run_in_background === true;
}

function asyncAgentResult(value: unknown): boolean {
  const root = record(value);
  const candidates = [root, record(root?.output), record(root?.result)];
  return candidates.some((candidate) => candidate?.isAsync === true
    || candidate?.status === "async_launched"
    || candidate?.status === "backgrounded"
    || typeof candidate?.backgroundTaskId === "string");
}

function toolScope(event: StreamEvent): {
  id?: string;
  name?: string;
  parentId?: string;
} {
  const part = event.part?.type === "tool" ? event.part : undefined;
  return {
    id: event.toolCallId ?? part?.toolCallId ?? part?.partId,
    name: event.toolName ?? part?.toolName,
    parentId: event.progress?.parentToolCallId ?? part?.parentToolCallId
  };
}

export class BackgroundTaskEventStore {
  private readonly activities = new Map<string, TaskActivityEntry[]>();
  private readonly handoffTurns = new Map<string, HandoffTurn>();
  private readonly pendingBackgroundTasks = new Set<string>();
  private readonly pendingSubagentMessages = new Set<string>();
  private readonly scopedTurnIds = new Set<string>();
  private readonly scopedToolCallIds = new Set<string>();
  private readonly toolParents = new Map<string, string>();
  private readonly seenEventIds = new Set<string>();
  private readonly recentTerminalNotices = new Map<string, { status: string; timestamp: number }>();

  handle(event: StreamEvent): TaskEventUpdate {
    this.rememberScopedTool(event);
    if (event.turnId && autonomousInputSource(event.inputSource)) this.rememberScopedTurn(event.turnId);
    if (event.eventId && !this.claim(event.eventId)) {
      return { changed: false, handoffSettled: false, notices: [] };
    }

    const notices: TaskEventNotice[] = [];
    let changed = false;
    let handoffSettled = false;
    const taskId = taskIdFor(event);

    if (event.type === "background_task_completed" && taskId) {
      this.pendingBackgroundTasks.add(taskId);
      const status = event.taskStatus ?? "completed";
      this.record(taskId, "system", `Task ${status.replaceAll("_", " ")}.`, event.turnId);
      if (taskFailure(status) && event.message) this.record(taskId, "error", event.message, event.turnId);
      changed = true;
      if (this.claimTerminalNotice(taskId, status)) {
        notices.push({
          notification: taskFailure(status) ? "failed" : "completed",
          summary: `${taskId} · /tasks`,
          title: taskFailure(status) ? "Background task needs attention" : "Background task completed",
          tone: taskFailure(status) ? "error" : "muted"
        });
      }
    } else if (event.type === "subagent_message" && taskId) {
      this.pendingSubagentMessages.add(taskId);
      if (event.message?.trim()) this.record(taskId, "assistant", event.message, event.turnId);
      changed = true;
      notices.push({
        notification: "completed",
        summary: `${taskId} · /tasks`,
        title: "Background agent replied",
        tone: "muted"
      });
    } else if (event.type === "subagent_stopped" && taskId) {
      const status = event.taskStatus ?? "stopped";
      const detail = event.message ?? `Agent ${status.replaceAll("_", " ")}.`;
      this.record(taskId, taskFailure(status) ? "error" : "system", detail, event.turnId);
      changed = true;
      if (taskFailure(status) && this.claimTerminalNotice(taskId, status)) {
        notices.push({
          notification: "failed",
          summary: `${taskId} · /tasks`,
          title: "Background agent needs attention",
          tone: "error"
        });
      }
    } else if ((event.type === "background_task_started" || event.type === "background_task_updated")
      && taskId
      && terminalTaskStatus(event.taskStatus)) {
      changed = true;
    }

    const started = event.type === "turn_started" || event.type === "turn.started";
    if (started
      && event.turnId
      && autonomousInputSource(event.inputSource)) {
      const pending = event.inputSource === "background_task"
        ? this.pendingBackgroundTasks
        : this.pendingSubagentMessages;
      const taskIds = [...new Set([...(event.taskIds ?? []), ...pending])];
      pending.clear();
      this.handoffTurns.set(event.turnId, { source: event.inputSource, taskIds });
      changed = taskIds.length > 0 || changed;
      return { changed, handoffSettled: false, notices };
    }

    const handoff = event.turnId ? this.handoffTurns.get(event.turnId) : undefined;
    if (handoff && event.kind === "text_delta" && event.delta) {
      for (const id of handoff.taskIds) this.appendHandoffDelta(id, event.turnId!, event.delta);
      changed = handoff.taskIds.length > 0 || changed;
    }

    const completed = event.type === "turn_complete" || event.type === "turn.completed";
    const failed = event.type === "turn_error" || event.type === "turn.failed";
    if (handoff && (completed || failed)) {
      this.handoffTurns.delete(event.turnId!);
      handoffSettled = true;
      if (failed) {
        const detail = event.message ?? "The task finished, but ZCode could not process its result.";
        for (const id of handoff.taskIds) this.record(id, "error", detail, event.turnId);
        notices.push({
          notification: "failed",
          summary: handoff.taskIds.length > 0
            ? `${handoff.taskIds.join(", ")} · /tasks`
            : "/tasks",
          title: "Background result processing failed",
          tone: "error"
        });
        changed = true;
      }
    }

    return { changed, handoffSettled, notices };
  }

  entries(taskId: string): readonly TaskActivityEntry[] {
    return this.activities.get(taskId) ?? [];
  }

  hasActiveHandoffs(): boolean {
    return this.handoffTurns.size > 0;
  }

  settleActiveHandoffs(): number {
    const count = this.handoffTurns.size;
    this.handoffTurns.clear();
    return count;
  }

  isTaskScoped(event: StreamEvent): boolean {
    return autonomousInputSource(event.inputSource)
      || Boolean(event.turnId && this.scopedTurnIds.has(event.turnId))
      || this.isBackgroundToolScoped(event);
  }

  isBackgroundToolScoped(event: StreamEvent): boolean {
    const scope = toolScope(event);
    const part = event.part?.type === "tool" ? event.part : undefined;
    return Boolean(isAgentDispatchTool(scope.name)
        && (explicitlyBackgroundAgentInput(event.input ?? part?.input)
          || asyncAgentResult(event.result ?? part?.output)))
      || Boolean(scope.id && this.scopedTool(scope.id))
      || Boolean(scope.parentId && this.scopedTool(scope.parentId));
  }

  recordUserMessage(taskId: string, message: string): void {
    this.record(taskId, "user", message);
  }

  recordSystemMessage(taskId: string, message: string, failed = false): void {
    this.record(taskId, failed ? "error" : "system", message);
  }

  private appendHandoffDelta(taskId: string, turnId: string, delta: string): void {
    const entries = this.activities.get(taskId) ?? [];
    const id = `handoff:${turnId}`;
    const existing = entries.find((entry) => entry.id === id);
    if (existing) {
      existing.text = bounded(existing.text + delta);
      existing.timestamp = Date.now();
    } else {
      entries.push({
        id,
        kind: "assistant",
        text: bounded(delta),
        timestamp: Date.now(),
        turnId
      });
    }
    this.retain(taskId, entries);
  }

  private record(taskId: string, kind: TaskActivityKind, text: string, turnId?: string): void {
    const value = text.trim();
    if (!value) return;
    const entries = this.activities.get(taskId) ?? [];
    entries.push({
      id: `task-event:${crypto.randomUUID()}`,
      kind,
      text: bounded(value),
      timestamp: Date.now(),
      ...(turnId ? { turnId } : {})
    });
    this.retain(taskId, entries);
  }

  private retain(taskId: string, entries: TaskActivityEntry[]): void {
    while (entries.length > maximumEntriesPerTask
      || entries.reduce((total, entry) => total + entry.text.length, 0) > maximumCharactersPerTask) {
      entries.shift();
    }
    this.activities.set(taskId, entries);
  }

  private claim(eventId: string): boolean {
    if (this.seenEventIds.has(eventId)) return false;
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > 4_096) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest) this.seenEventIds.delete(oldest);
    }
    return true;
  }

  private rememberScopedTurn(turnId: string): void {
    if (this.scopedTurnIds.has(turnId)) return;
    this.scopedTurnIds.add(turnId);
    if (this.scopedTurnIds.size > maximumScopedTurnIds) {
      const oldest = this.scopedTurnIds.values().next().value;
      if (oldest) this.scopedTurnIds.delete(oldest);
    }
  }

  private rememberScopedTool(event: StreamEvent): void {
    const scope = toolScope(event);
    if (scope.id && scope.parentId) this.rememberToolParent(scope.id, scope.parentId);
    const part = event.part?.type === "tool" ? event.part : undefined;
    const backgroundLifecycleParent = (event.type === "background_task_started"
      || event.type === "background_task_updated")
      && (event.taskKind === "local_agent" || isAgentDispatchTool(event.toolName))
      ? event.progress?.parentToolCallId
      : undefined;
    if (backgroundLifecycleParent) this.rememberScopedToolCall(backgroundLifecycleParent);
    if (!scope.id) return;
    if ((isAgentDispatchTool(scope.name)
        && (explicitlyBackgroundAgentInput(event.input ?? part?.input)
          || asyncAgentResult(event.result ?? part?.output)))
      || Boolean(scope.parentId && this.scopedTool(scope.parentId))) {
      this.rememberScopedToolCall(scope.id);
    }
  }

  private scopedTool(toolCallId: string): boolean {
    let current: string | undefined = toolCallId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      if (this.scopedToolCallIds.has(current)) return true;
      visited.add(current);
      current = this.toolParents.get(current);
    }
    return false;
  }

  private rememberToolParent(toolCallId: string, parentToolCallId: string): void {
    this.toolParents.delete(toolCallId);
    this.toolParents.set(toolCallId, parentToolCallId);
    if (this.toolParents.size > maximumScopedToolCallIds) {
      const oldest = this.toolParents.keys().next().value;
      if (oldest) this.toolParents.delete(oldest);
    }
  }

  private rememberScopedToolCall(toolCallId: string): void {
    if (this.scopedToolCallIds.has(toolCallId)) return;
    this.scopedToolCallIds.add(toolCallId);
    if (this.scopedToolCallIds.size > maximumScopedToolCallIds) {
      const oldest = this.scopedToolCallIds.values().next().value;
      if (oldest) this.scopedToolCallIds.delete(oldest);
    }
  }

  private claimTerminalNotice(taskId: string, status: string): boolean {
    const now = Date.now();
    const recent = this.recentTerminalNotices.get(taskId);
    this.recentTerminalNotices.set(taskId, { status, timestamp: now });
    return !recent || recent.status !== status || now - recent.timestamp > 5_000;
  }
}
