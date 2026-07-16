import { isDeepStrictEqual } from "node:util";

import type { StreamEvent } from "./events.ts";
import type {
  RuntimeProjectionSnapshot,
  RuntimeTodo,
  RuntimeTodoGroup
} from "./runtime-projection.ts";

export const ACTIVE_RUNTIME_POLL_INTERVAL_MS = 1_000;
export const IDLE_RUNTIME_POLL_INTERVAL_MS = 5_000;

export interface RuntimePollState {
  projection?: RuntimeProjectionSnapshot;
  todos: RuntimeTodo[];
  todoGroups: RuntimeTodoGroup[];
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
