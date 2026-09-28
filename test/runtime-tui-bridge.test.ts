import { expect, test } from "bun:test";
import { fixtureSubagentQueries, subagentRestoreFixture } from "./fixtures/runtime-subagents.ts";
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

const restore = (app: RuntimeTuiApp) => restoreTuiBackgroundTasks(app, fixtureSubagentQueries);

test("concurrent task sends wait for an in-flight session restoration", async () => {
  const { app } = subagentRestoreFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const getSession = app.runtime!.sessionStore!.getSession;
  let reads = 0, sends = 0;
  app.runtime!.sessionStore!.getSession = async (id) => { reads++; await gate; return getSession(id); };
  app.runtime!.subagentPort = { sendMessage: async () => { sends++; return "sent"; } };
  const restoration = restore(app);
  const send = sendTuiBackgroundTaskMessage(app, { $zRestorePersistedBackgroundTasks: restore }, {
    taskId: "agent", message: "Continue"
  });
  await Promise.resolve();
  expect(sends).toBe(0);
  release();
  await restoration;
  expect(await send).toBe("sent");
  expect(sends).toBe(1);
  expect(reads).toBe(2);
});

test("restores native subagent projections without reading the legacy transcript", async () => {
  const { app, tasks, reminders } = subagentRestoreFixture();
  app.loadSessionTranscript = async () => { throw new Error("Legacy transcript must not be read"); };
  await restore(app);
  expect(tasks.get("agent")).toMatchObject({
    childSessionId: "child", status: "completed", parentToolCallId: "call", agentType: "Explore",
    parentSessionId: "parent", startedAt: 10, completedAt: 20
  });
  expect(reminders).toHaveLength(1);
  await restore(app);
  expect(reminders).toHaveLength(1);
});

test.each(["getSession", "messages", "events"])("retries a transient %s failure", async (operation) => {
  const { app, tasks } = subagentRestoreFixture();
  let reads = 0;
  if (operation === "events") {
    app.runtime!.getSessionEventStore = () => ({ getEvents: async () => {
      if (++reads === 1) throw new Error("database is locked");
      return [];
    } });
  } else {
    const store = app.runtime!.sessionStore!;
    if (operation === "getSession") {
      const getSession = store.getSession;
      store.getSession = async (id) => {
        if (++reads === 1) throw new Error("database is locked");
        return getSession(id);
      };
    } else {
      const messages = store.messages;
      store.messages = async (input) => {
        if (++reads === 1) throw new Error("database is locked");
        return messages(input);
      };
    }
  }
  await restore(app);
  expect(tasks.size).toBe(0);
  expect(app.$zRestoredBackgroundTasksSession).toBeUndefined();
  await restore(app);
  expect(tasks.size).toBe(1);
});

test.each(["foreign", "wrong-type", "missing"])("rejects %s child sessions before reading their content", async (kind) => {
  const { app, sessions, tasks } = subagentRestoreFixture();
  if (kind === "missing") sessions.delete("child");
  else sessions.set("child", { id: "child", parentID: kind === "foreign" ? "other" : "parent", taskType: kind === "wrong-type" ? "main" : "subagent_child" });
  const messages = app.runtime!.sessionStore!.messages;
  app.runtime!.sessionStore!.messages = async (input) => {
    expect(input.sessionID).toBe("parent");
    return messages(input);
  };
  await restore(app);
  expect(tasks.size).toBe(0);
});

test("does not overwrite a task registered while storage was being read", async () => {
  const { app, tasks, reminders } = subagentRestoreFixture();
  const live: RuntimeTask = { taskId: "agent", status: "running", description: "Live task" };
  app.runtime!.getSessionEventStore = () => ({ getEvents: async () => { tasks.set("agent", live); return []; } });
  await restore(app);
  expect(tasks.get("agent")).toBe(live);
  expect(reminders).toEqual([]);
});

test("discards restoration when navigation changes the active session", async () => {
  const { app, tasks, reminders } = subagentRestoreFixture();
  const messages = app.runtime!.sessionStore!.messages;
  app.runtime!.sessionStore!.messages = async (input) => { app.sessionId = "other"; return messages(input); };
  await restore(app);
  expect(tasks.size).toBe(0);
  expect(reminders).toEqual([]);
  expect(app.$zRestoredBackgroundTasksSession).toBeUndefined();
});

test("does not fall back when session observation is unavailable", async () => {
  const { app, tasks } = subagentRestoreFixture();
  delete app.runtime!.sessionStore;
  app.loadSessionTranscript = async () => { throw new Error("Legacy transcript must not be read"); };
  await restore(app);
  expect(tasks.size).toBe(0);
});
