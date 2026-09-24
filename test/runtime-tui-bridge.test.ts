import { expect, test } from "bun:test";
import { restoreTuiBackgroundTasks } from "../src/runtime-background-restore.ts";
import { readTuiRuntimeProjection, sendTuiBackgroundTaskMessage, type RuntimeTask, type RuntimeTuiApp } from "../src/runtime-tui-bridge.ts";

test("projection merges registry state without mutating persisted entries", async () => {
  const original = { taskId: "agent", description: "Saved description", status: "failed", error: "Old failure", completedAt: 10 };
  const app: RuntimeTuiApp = {
    readExecutionState: () => ({ mode: "edit", planEnabled: true }),
    runtime: {
      getProjection: () => ({ backgroundTasks: [original] }),
      runtimeTaskRegistry: { all: () => ({
        agent: { taskId: "agent", type: "local_agent", status: "running", isBackgrounded: true },
        foreground: { taskId: "foreground", type: "local_agent", status: "running" }
      }) }
    }
  };
  let restored = false;
  const projection = await readTuiRuntimeProjection(app, { $zRestorePersistedBackgroundTasks: async () => { restored = true; } });
  expect(restored).toBeTrue();
  expect(projection).toMatchObject({ mode: "edit", planEnabled: true, backgroundTasks: [{
    taskId: "agent", description: "Saved description", status: "running", error: null, completedAt: null, cancellable: true
  }] });
  expect(projection?.backgroundTaskDetails).toHaveLength(1);
  expect(original.status).toBe("failed");
});

test("task restart awaits stop and uses refreshed routing and trace data", async () => {
  let task: RuntimeTask = { taskId: "agent", type: "local_agent", status: "running" };
  const calls: string[] = [];
  let message: Record<string, unknown> | undefined;
  const app: RuntimeTuiApp = {
    readExecutionState: () => ({}),
    runtime: {
      workingDirectory: "/workspace",
      rootTraceContext: { traceId: "root" },
      runtimeTaskRegistry: { get: () => task },
      subagentPort: {
        stopTask: async () => {
          calls.push("stop");
          task = { ...task, status: "stopped", parentSessionId: "parent", parentToolCallId: "call", agentId: "restored" };
        },
        sendMessage: async (input) => { calls.push("send"); message = input; return { status: "success" }; }
      }
    }
  };
  await sendTuiBackgroundTaskMessage(app, {}, { taskId: "agent", message: "x".repeat(21_000), summary: "  Continue\n here  ", restart: true });
  expect(calls).toEqual(["stop", "send"]);
  expect(message).toMatchObject({ to: "restored", parentToolCallId: "call", sessionId: "parent", summary: "Continue here", trace: { traceId: "root" } });
  expect(String(message?.message)).toHaveLength(20_000);
});

test("task messaging retries restoration and rejects unsupported or invalid actions", async () => {
  let task: RuntimeTask | undefined;
  let restores = 0;
  let sends = 0;
  const app: RuntimeTuiApp = {
    sessionId: "parent", readExecutionState: () => ({}),
    runtime: {
      runtimeTaskRegistry: { get: () => task },
      subagentPort: { sendMessage: async () => { sends++; return "sent"; } }
    }
  };
  const bridge = { $zRestorePersistedBackgroundTasks: async () => {
    if (++restores === 2) task = { taskId: "agent", type: "local_agent", status: "stopped" };
  } };
  expect(await sendTuiBackgroundTaskMessage(app, bridge, { taskId: "agent", message: "Continue" })).toBe("sent");
  expect(restores).toBe(2);
  await expect(sendTuiBackgroundTaskMessage(app, {}, { taskId: "agent", message: " " })).rejects.toThrow("Enter a message");
  task = { taskId: "agent", type: "local_agent", status: "running" };
  await expect(sendTuiBackgroundTaskMessage(app, {}, { taskId: "agent", message: "Continue", restart: true })).rejects.toThrow("restart is unavailable");
  task = { taskId: "agent", type: "local_bash", status: "running" };
  await expect(sendTuiBackgroundTaskMessage(app, {}, { taskId: "agent", message: "Continue" })).rejects.toThrow("not a local agent");
  expect(sends).toBe(1);
});

test("concurrent task sends wait for an in-flight transcript restoration", async () => {
  let release!: (messages: unknown[]) => void;
  let reads = 0;
  let sends = 0;
  const tasks = new Map<string, RuntimeTask>();
  const app: RuntimeTuiApp = {
    sessionId: "parent", readExecutionState: () => ({}),
    loadSessionTranscript: () => { reads++; return new Promise((resolve) => { release = resolve; }); },
    runtime: {
      runtimeTaskRegistry: { register: (task) => tasks.set(task.taskId, task), get: (id) => tasks.get(id) },
      subagentPort: { sendMessage: async () => { sends++; return "sent"; } }
    }
  };
  const restoration = restoreTuiBackgroundTasks(app);
  const send = sendTuiBackgroundTaskMessage(app, { $zRestorePersistedBackgroundTasks: restoreTuiBackgroundTasks }, {
    taskId: "agent", message: "Continue"
  });
  await Promise.resolve();
  expect(sends).toBe(0);
  release([{ parts: [{ type: "tool", toolName: "Agent", output: JSON.stringify({ status: "async_launched", agentId: "agent" }) }] }]);
  await restoration;
  expect(await send).toBe("sent");
  expect(reads).toBe(1);
  expect(sends).toBe(1);
});
