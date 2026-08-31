import { describe, expect, test } from "bun:test";

import { BackgroundTaskEventStore } from "../packages/zcode-tui/src/background-task-events.ts";
import { normalizeEvent } from "../packages/zcode-tui/src/events.ts";

function event(value: unknown) {
  const normalized = normalizeEvent(value);
  if (!normalized) throw new Error("Expected a normalized event.");
  return normalized;
}

describe("background task event store", () => {
  test("routes autonomous output to its task without treating handoff completion as task completion", () => {
    const store = new BackgroundTaskEventStore();
    const completed = store.handle(event({
      id: "task-completed",
      type: "background_task_completed",
      turnId: "parent-turn",
      payload: { taskId: "bg-1", status: "completed", taskKind: "bash" }
    }));
    expect(completed.notices).toEqual([expect.objectContaining({
      title: "Background task completed",
      summary: "bg-1 · /tasks"
    })]);

    store.handle(event({
      id: "handoff-started",
      type: "turn_started",
      turnId: "handoff-turn",
      payload: {
        inputSource: "background_task",
        originMeta: { workId: "bg-1" }
      }
    }));
    expect(store.hasActiveHandoffs()).toBe(true);
    store.handle(event({
      id: "handoff-text",
      type: "model.streaming",
      turnId: "handoff-turn",
      payload: { kind: "text_delta", delta: "Task output was reviewed." }
    }));
    const settled = store.handle(event({
      id: "handoff-completed",
      type: "turn_complete",
      turnId: "handoff-turn",
      payload: {}
    }));

    expect(settled.handoffSettled).toBe(true);
    expect(settled.notices).toEqual([]);
    expect(store.hasActiveHandoffs()).toBe(false);
    expect(store.entries("bg-1").map((entry) => entry.text)).toEqual([
      "Task completed.",
      "Task output was reviewed."
    ]);
  });

  test("keeps result-processing failure separate from the underlying task status", () => {
    const store = new BackgroundTaskEventStore();
    store.handle(event({
      id: "task-completed",
      type: "background_task_completed",
      payload: { taskId: "bg-2", status: "completed" }
    }));
    store.handle(event({
      id: "handoff-started",
      type: "turn_started",
      turnId: "handoff-failed",
      payload: { inputSource: "background_task" }
    }));
    const failed = store.handle(event({
      id: "handoff-error",
      type: "turn_error",
      turnId: "handoff-failed",
      payload: { error: { message: "Provider unavailable during handoff." } }
    }));

    expect(failed.notices).toEqual([expect.objectContaining({
      title: "Background result processing failed",
      summary: "bg-2 · /tasks"
    })]);
    expect(store.entries("bg-2").at(-1)).toMatchObject({
      kind: "error",
      text: "Provider unavailable during handoff."
    });
    expect(store.isTaskScoped(event({
      id: "late-handoff-event",
      type: "model.streaming",
      turnId: "handoff-failed",
      payload: { kind: "reasoning_delta", delta: "late autonomous output" }
    }))).toBe(true);
  });

  test("settles a stuck autonomous handoff when the user preempts it", () => {
    const store = new BackgroundTaskEventStore();
    store.handle(event({
      id: "stuck-handoff-started",
      type: "turn_started",
      turnId: "stuck-handoff",
      payload: { inputSource: "background_task" }
    }));

    expect(store.hasActiveHandoffs()).toBe(true);
    expect(store.settleActiveHandoffs()).toBe(1);
    expect(store.hasActiveHandoffs()).toBe(false);
    expect(store.settleActiveHandoffs()).toBe(0);
  });

  test("records agent replies once and allows a task-scoped user follow-up", () => {
    const store = new BackgroundTaskEventStore();
    const reply = event({
      id: "agent-reply",
      type: "subagent_message",
      payload: {
        agentId: "agent-1",
        agentType: "reviewer",
        message: "I found the failing test."
      }
    });
    store.handle(reply);
    store.handle(reply);
    store.recordUserMessage("agent-1", "Fix it and rerun the focused test.");

    expect(store.entries("agent-1").map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "assistant", text: "I found the failing test." },
      { kind: "user", text: "Fix it and rerun the focused test." }
    ]);
  });

  test("deduplicates paired agent terminal events without dropping the error detail", () => {
    const store = new BackgroundTaskEventStore();
    const task = store.handle(event({
      id: "agent-task-failed",
      type: "background_task_completed",
      payload: { taskId: "agent-2", toolName: "Agent", status: "failed" }
    }));
    const lifecycle = store.handle(event({
      id: "agent-stopped",
      type: "subagent_stopped",
      payload: {
        agentId: "agent-2",
        status: "failed",
        error: "The provider connection closed."
      }
    }));

    expect(task.notices).toHaveLength(1);
    expect(lifecycle.notices).toEqual([]);
    expect(store.entries("agent-2").at(-1)).toMatchObject({
      kind: "error",
      text: "The provider connection closed."
    });
  });

  test("treats the runtime killed status as a terminal task update", () => {
    const store = new BackgroundTaskEventStore();
    const update = store.handle(event({
      id: "agent-killed-update",
      type: "background_task_updated",
      payload: { taskId: "agent-killed", taskKind: "local_agent", status: "killed" }
    }));

    expect(update.changed).toBeTrue();
    expect(update.notices).toEqual([]);
  });

  test("scopes Agent tool trees and their descendants to the task center", () => {
    const store = new BackgroundTaskEventStore();
    const agent = event({
      id: "agent-part",
      type: "part.started",
      payload: {
        part: {
          type: "tool",
          partId: "part-agent",
          messageId: "message-coordinator",
          callId: "call-agent",
          tool: "Agent",
          state: {
            status: "running",
            input: { description: "Research rendering", run_in_background: true }
          }
        }
      }
    });
    store.handle(agent);

    const child = event({
      id: "child-part",
      type: "part.started",
      payload: {
        part: {
          type: "tool",
          partId: "part-fetch",
          messageId: "message-coordinator",
          callId: "call-fetch",
          tool: "Fetch",
          state: {
            status: "running",
            input: { url: "https://example.com" },
            metadata: { parentToolCallId: "call-agent" }
          }
        }
      }
    });
    store.handle(child);

    const unrelated = event({
      id: "foreground-fetch",
      type: "tool_call_started",
      payload: { toolCallId: "call-foreground", toolName: "Fetch" }
    });
    store.handle(unrelated);

    expect(store.isBackgroundToolScoped(agent)).toBe(true);
    expect(store.isTaskScoped(child)).toBe(true);
    expect(store.isTaskScoped(unrelated)).toBe(false);
  });

  test("treats the Task compatibility alias as an Agent dispatch", () => {
    const store = new BackgroundTaskEventStore();
    const task = event({
      id: "task-alias-part",
      type: "part.started",
      payload: {
        part: {
          type: "tool",
          partId: "part-task-alias",
          callId: "call-task-alias",
          tool: "Task",
          state: {
            status: "running",
            input: { description: "Review aliases", run_in_background: true }
          }
        }
      }
    });
    store.handle(task);
    expect(store.isBackgroundToolScoped(task)).toBe(true);
  });

  test("keeps synchronous agents in the foreground until the runtime backgrounds them", () => {
    const store = new BackgroundTaskEventStore();
    const started = event({
      id: "foreground-agent-started",
      type: "part.started",
      payload: {
        part: {
          type: "tool",
          partId: "part-agent-auto",
          messageId: "message-auto",
          callId: "call-agent-auto",
          tool: "Agent",
          state: { status: "running", input: { description: "Research runtime" } }
        }
      }
    });
    store.handle(started);
    expect(store.isTaskScoped(started)).toBe(false);

    const child = event({
      id: "foreground-agent-child",
      type: "part.started",
      payload: {
        part: {
          type: "tool",
          partId: "part-agent-child",
          callId: "call-agent-child",
          tool: "Fetch",
          state: { status: "running", metadata: { parentToolCallId: "call-agent-auto" } }
        }
      }
    });
    store.handle(child);
    expect(store.isTaskScoped(child)).toBe(false);

    const backgrounded = event({
      id: "foreground-agent-backgrounded",
      type: "part.upserted",
      payload: {
        part: {
          type: "tool",
          partId: "part-agent-auto",
          messageId: "message-auto",
          callId: "call-agent-auto",
          tool: "Agent",
          state: {
            status: "completed",
            input: { description: "Research runtime" },
            output: {
              status: "async_launched",
              isAsync: true,
              backgroundTaskId: "agent-auto"
            }
          }
        }
      }
    });
    store.handle(backgrounded);

    expect(store.isTaskScoped(backgrounded)).toBe(true);
    expect(store.isTaskScoped(child)).toBe(true);
  });
});
