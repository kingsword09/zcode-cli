import { isDeepStrictEqual } from "node:util";

import type { StreamEvent } from "./events.ts";
import {
  isActiveBackgroundJob,
  isActiveRuntimeTool,
  type RuntimeProjectionSnapshot,
  type RuntimeTodo,
  type RuntimeTodoGroup
} from "./runtime-projection.ts";

export const ACTIVE_RUNTIME_POLL_INTERVAL_MS = 1_000;
export const IDLE_RUNTIME_POLL_INTERVAL_MS = 5_000;

export interface RuntimePollState {
  projection?: RuntimeProjectionSnapshot;
  todos: RuntimeTodo[];
  todoGroups: RuntimeTodoGroup[];
}

export function runtimeActivityActive(projection: RuntimeProjectionSnapshot | undefined): boolean {
  return Boolean(projection?.activeToolCalls.some(isActiveRuntimeTool)
    || projection?.backgroundJobs.some(isActiveBackgroundJob));
}

export function runtimePollInterval(active: boolean): number {
  return active ? ACTIVE_RUNTIME_POLL_INTERVAL_MS : IDLE_RUNTIME_POLL_INTERVAL_MS;
}

export function runtimePollStateChanged(current: RuntimePollState, next: RuntimePollState): boolean {
  return !isDeepStrictEqual(current, next);
}

export function runtimeRefreshNeeded(
  event: Pick<StreamEvent, "field" | "kind" | "type">
): boolean {
  if (event.type === "part.delta") return false;
  return event.kind !== "text_delta"
    && event.kind !== "reasoning_delta"
    && event.kind !== "tool_input_delta";
}

const contextChangeEvents = new Set([
  "model_complete", "model.complete", "turn_complete", "turn.completed",
  "turn_error", "turn.failed", "session_created", "session_resumed", "session_forked",
  "session_compacted", "compact_boundary", "rewind_triggered", "rewind.triggered"
]);

export function runtimeContextRefreshNeeded(event: Pick<StreamEvent, "type">): boolean {
  return event.type !== undefined && contextChangeEvents.has(event.type);
}

/** Polling also notices completed work from runtimes without session events. */
export function runtimeContextChanged(
  current: RuntimeProjectionSnapshot | undefined,
  next: RuntimeProjectionSnapshot | undefined
): boolean {
  return current?.sessionId !== next?.sessionId
    || current?.turnCount !== next?.turnCount
    || current?.totalTokenCount !== next?.totalTokenCount
    || current?.contextUsage?.used !== next?.contextUsage?.used;
}
