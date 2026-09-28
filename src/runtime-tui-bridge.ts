/** Narrow structural boundary; the extracted runtime remains the state owner. */
export interface RuntimeTask extends Record<string, unknown> {
  taskId: string;
  type?: string;
  taskType?: string;
  status?: string;
  isBackgrounded?: boolean;
  error?: unknown;
}

export interface RuntimeTuiApp {
  sessionId?: string;
  $zRestoredBackgroundTasksSession?: string;
  $zRestoredBackgroundTasksLog?: unknown[];
  loadSessionTranscript?(): Promise<unknown[]>;
  readExecutionState(): Promise<unknown> | unknown;
  runtime?: {
    sessionStore?: RuntimeSessionStore;
    getSessionEventStore?(): RuntimeSessionEventStore;
    getProjection?(): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
    getSessionId?(): string;
    runtimeTaskRegistry?: {
      all?(): Record<string, RuntimeTask>;
      get?(taskId: string): RuntimeTask | undefined;
      register?(task: RuntimeTask): unknown;
    };
    messageHistory?: { addAttachment?(source: string, text: string): unknown };
    subagentPort?: {
      sendMessage?(input: Record<string, unknown>): Promise<unknown>;
      stopTask?(taskId: string): Promise<unknown>;
    };
    workingDirectory?: string;
    rootTraceContext?: unknown;
  };
}

export interface RuntimeSessionInfo {
  id: string;
  parentID?: string;
  taskType?: string;
  title?: string;
  time?: { created?: number; updated?: number };
}

export interface RuntimeSessionStore {
  getSession(sessionId: string): Promise<RuntimeSessionInfo | null>;
  messages(input: { sessionID: string }): Promise<unknown[]>;
}

export interface RuntimeSessionEventStore {
  getEvents(sessionId: string): Promise<unknown[]>;
}

export interface RuntimeSubagent {
  agentId?: string;
  childSessionId: string;
  toolCallId: string;
  subagentType: string;
  title: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
}

/** Implemented by the extracted runtime's native session query and reducer. */
export interface RuntimeSubagentQueries {
  collectChildSessionIds(session: RuntimeSessionInfo, messages: unknown[], events: unknown[]): string[];
  projectChildEvents(events: unknown[]): unknown;
  projectSubagents(input: {
    revision: number;
    parentSession: RuntimeSessionInfo;
    messages: unknown[];
    parentEvents: unknown[];
    parentProjection?: Record<string, unknown>;
    childSessionsById: Map<string, RuntimeSessionInfo>;
    childMessagesById: Map<string, unknown[]>;
    childProjectionsById: Map<string, unknown>;
  }): { running: RuntimeSubagent[]; ended: RuntimeSubagent[] };
}

export interface RuntimeTuiBridge {
  $zRestorePersistedBackgroundTasks?(app: RuntimeTuiApp): Promise<void>;
}

const maximumTaskMessageLength = 20_000;
const maximumTaskSummaryLength = 200;

function taskDetail(task: RuntimeTask): Record<string, unknown> {
  const running = task.status === "running";
  const kind = task.taskType ?? task.type;
  return {
    taskId: task.taskId,
    taskKind: kind,
    agentId: task.agentId,
    agentType: task.agentType,
    childSessionId: task.childSessionId,
    parentSessionId: task.parentSessionId,
    parentToolCallId: task.parentToolCallId,
    turnId: task.turnId,
    prompt: task.prompt,
    error: running ? null : task.error instanceof Error ? task.error.message
      : typeof task.error === "string" ? task.error : undefined,
    outputPath: task.outputFile,
    status: task.status,
    description: task.description,
    startedAt: task.startedAt,
    completedAt: running ? null : task.completedAt,
    cancelRequestedAt: running ? null : task.cancelRequestedAt,
    blocked: running ? null : task.blocked,
    blockedReason: running ? null : task.blockedReason,
    cancellable: kind === "local_agent" ? running : task.cancellable
  };
}

export async function readTuiRuntimeProjection(
  app: RuntimeTuiApp,
  bridge: RuntimeTuiBridge
): Promise<Record<string, unknown> | null> {
  const executionState = await app.readExecutionState();
  await bridge.$zRestorePersistedBackgroundTasks?.(app);
  const projection = await app.runtime?.getProjection?.();
  if (!projection) return null;
  const details = Object.values(app.runtime?.runtimeTaskRegistry?.all?.() ?? {})
    .filter((task) => task.isBackgrounded === true).map(taskDetail);
  const tasks: Array<Record<string, unknown>> = Array.isArray(projection.backgroundTasks)
    ? projection.backgroundTasks.slice() : [];
  for (const detail of details) {
    const index = tasks.findIndex((existing) => existing.taskId === detail.taskId);
    if (index < 0) tasks.push(detail);
    else tasks[index] = {
      ...tasks[index],
      ...Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== undefined))
    };
  }
  return {
    ...projection,
    ...(executionState && typeof executionState === "object" ? executionState : {}),
    backgroundTasks: tasks,
    backgroundTaskDetails: details,
    restoredBackgroundTasks: Array.isArray(app.$zRestoredBackgroundTasksLog)
      ? app.$zRestoredBackgroundTasksLog : []
  };
}

export interface BackgroundTaskMessage {
  taskId: string;
  message: string;
  summary?: string;
  restart?: boolean;
}

export async function sendTuiBackgroundTaskMessage(
  app: RuntimeTuiApp,
  bridge: RuntimeTuiBridge,
  input: BackgroundTaskMessage
): Promise<unknown> {
  await bridge.$zRestorePersistedBackgroundTasks?.(app);
  const runtime = app.runtime;
  let task = runtime?.runtimeTaskRegistry?.get?.(input?.taskId);
  if (!task && typeof app.sessionId === "string") {
    app.$zRestoredBackgroundTasksSession = undefined;
    await bridge.$zRestorePersistedBackgroundTasks?.(app);
    task = runtime?.runtimeTaskRegistry?.get?.(input?.taskId);
  }
  if (!runtime?.subagentPort?.sendMessage) throw new Error("Background agent messaging is unavailable in this runtime.");
  if (!task || (task.type ?? task.taskType) !== "local_agent") throw new Error("The selected task is not a local agent.");
  if (typeof input?.message !== "string" || !input.message.trim()) throw new Error("Enter a message for the background agent.");
  const message = input.message.trim().slice(0, maximumTaskMessageLength);
  const summary = (typeof input.summary === "string" ? input.summary : message)
    .replace(/\s+/g, " ").trim().slice(0, maximumTaskSummaryLength);
  if (input.restart === true && task.status === "running") {
    if (!runtime.subagentPort.stopTask) throw new Error("Background agent restart is unavailable in this runtime.");
    await runtime.subagentPort.stopTask(input.taskId);
    task = runtime.runtimeTaskRegistry?.get?.(input.taskId);
    if (!task) throw new Error("The background agent stopped but could not be restored.");
  }
  return await runtime.subagentPort.sendMessage({
    sessionId: task.parentSessionId ?? runtime.getSessionId?.(),
    turnId: task.turnId ?? "tui-task-message",
    parentToolCallId: task.parentToolCallId ?? "tui-task-message",
    to: task.agentId ?? input.taskId,
    summary,
    message,
    workingDirectory: task.workingDirectory ?? runtime.workingDirectory,
    workspaceRoot: task.workspaceRoot ?? runtime.workingDirectory,
    trace: task.traceContext ?? runtime.rootTraceContext
  });
}
