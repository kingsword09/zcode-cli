import type { RuntimeSubagentQueries, RuntimeTask, RuntimeTuiApp } from "./runtime-tui-bridge.ts";

const maximumReminderTasks = 32;
const maximumReminderLength = 4_000;
const maximumRestoredTasks = 64;

async function restoreSessionChildren(
  app: RuntimeTuiApp, sessionId: string, queries: RuntimeSubagentQueries
): Promise<RuntimeTask[]> {
  const store = app.runtime?.sessionStore;
  const eventStore = app.runtime?.getSessionEventStore?.();
  if (!store || !eventStore) return [];
  const parentSession = await store.getSession(sessionId);
  if (!parentSession) return [];
  const [messages, parentEvents, parentProjection] = await Promise.all([
    store.messages({ sessionID: sessionId }), eventStore.getEvents(sessionId), app.runtime?.getProjection?.()
  ]);
  // Use the same active-branch candidates and ownership checks as upstream's
  // subagent observation API. Event storage alone is empty after a cold resume.
  const ids = [...new Set(queries.collectChildSessionIds(parentSession, messages, parentEvents))];
  const children = await Promise.all(ids.map(async (id) => {
    const session = await store.getSession(id);
    if (!session || session.parentID !== sessionId || session.taskType !== "subagent_child") return null;
    const [messages, events] = await Promise.all([
      store.messages({ sessionID: id }), eventStore.getEvents(id)
    ]);
    return { session, messages, projection: events.length ? queries.projectChildEvents(events) : undefined };
  }));
  const valid = children.filter((child) => child !== null);
  const projection = queries.projectSubagents({
    revision: 0, parentSession, messages, parentEvents, parentProjection,
    childSessionsById: new Map(valid.map((child) => [child.session.id, child.session])),
    childMessagesById: new Map(valid.map((child) => [child.session.id, child.messages])),
    childProjectionsById: new Map(valid.flatMap((child) =>
      child.projection ? [[child.session.id, child.projection] as const] : []))
  });
  return [...projection.running, ...projection.ended].map((agent): RuntimeTask => ({
    taskId: agent.agentId ?? agent.toolCallId,
    agentId: agent.agentId ?? agent.toolCallId,
    agentType: agent.subagentType,
    childSessionId: agent.childSessionId,
    description: agent.title,
    isBackgrounded: true,
    parentSessionId: sessionId,
    parentToolCallId: agent.toolCallId,
    startedAt: agent.startedAt,
    completedAt: agent.endedAt,
    status: ["running", "waiting", "blocked"].includes(agent.status) ? "running"
      : agent.status === "success" ? "completed" : agent.status === "failed" ? "failed" : "stopped",
    error: agent.status === "failed" ? agent.summary : undefined,
    output: agent.status === "success" && agent.summary
      ? { status: "completed", content: [{ type: "text", text: agent.summary }] } : undefined,
    taskType: "local_agent",
    type: "local_agent"
  }));
}

async function restore(app: RuntimeTuiApp, queries: RuntimeSubagentQueries): Promise<void> {
  const runtime = app.runtime;
  const registry = runtime?.runtimeTaskRegistry;
  const sessionId = app.sessionId;
  if (!registry?.register || typeof sessionId !== "string" || sessionId === app.$zRestoredBackgroundTasksSession) return;
  app.$zRestoredBackgroundTasksLog = [];
  try {
    const tasks = await restoreSessionChildren(app, sessionId, queries);
    // A restore may finish after navigation, or after a live task was registered.
    if (app.sessionId !== sessionId || app.runtime !== runtime) return;
    const restored: RuntimeTask[] = [];
    for (const task of tasks) {
      if (registry.get?.(task.taskId)) continue;
      registry.register(task);
      restored.push(task);
    }
    app.$zRestoredBackgroundTasksSession = sessionId;
    if (restored.length === 0) return;
    const taskIds = restored.slice(-maximumReminderTasks)
      .map((task) => `- ${task.taskId} (${task.status})`).join("\n").slice(0, maximumReminderLength);
    runtime?.messageHistory?.addAttachment?.("task_status",
      "Background agent tasks from this resumed session have been restored and are available again.\n"
      + 'Earlier TaskOutput errors saying "No task found" occurred before restoration and are stale.\n'
      + "Use TaskOutput to collect results or SendMessage to continue a task. Do not assume these tasks were lost.\n"
      + `Restored task IDs:\n${taskIds}`);
    app.$zRestoredBackgroundTasksLog = [...(app.$zRestoredBackgroundTasksLog ?? []), ...restored].slice(-maximumRestoredTasks);
  } catch {
    // Restoration is supplementary. Let the next query retry a failed read.
    if (app.sessionId === sessionId) app.$zRestoredBackgroundTasksSession = undefined;
  }
}

const pendingRestores = new WeakMap<RuntimeTuiApp, Promise<void>>();

export async function restoreTuiBackgroundTasks(app: RuntimeTuiApp, queries: RuntimeSubagentQueries): Promise<void> {
  const pending = pendingRestores.get(app);
  if (pending) {
    await pending;
    return restoreTuiBackgroundTasks(app, queries);
  }
  const operation = restore(app, queries);
  pendingRestores.set(app, operation);
  try { await operation; }
  finally { pendingRestores.delete(app); }
}
