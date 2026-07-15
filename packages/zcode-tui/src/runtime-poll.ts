import { isDeepStrictEqual } from "node:util";

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
