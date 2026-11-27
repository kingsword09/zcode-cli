import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { historicalTasks } from "./runtime-background-restore.ts";

const execFileAsync = promisify(execFile);
const workspaceSnapshots = new WeakMap<object, {
  directory: string;
  snapshot: Promise<{ directory: string; branch?: string }>;
}>();

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
  readSubagents?(input: { endedCursor?: string; endedLimit: number }): Promise<{
    running: RuntimeSubagent[]; ended: { items: RuntimeSubagent[]; nextCursor?: string };
  }>;
  cancelBackgroundTask?(id: string): Promise<unknown>;
  loadSessionTranscript?(): Promise<unknown[]>;
  readExecutionState(): Promise<unknown> | unknown;
  runtime?: {
    transcriptAgentOutputFiles?: Map<string, string>;
    stopBackgroundTask?(id: string, options: { strict: true; initiator: "user"; expectedExecutionId: string }):
      Promise<{ ok: boolean; reason?: string }>;
    getProjection?(): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
    getSessionId?(): string;
    runtimeTaskRegistry?: {
      all?(): Record<string, RuntimeTask>;
      get?(taskId: string): RuntimeTask | undefined;
    };
    subagentPort?: {
      sendMessage?(input: Record<string, unknown>): Promise<unknown>;
    };
    workingDirectory?: string;
    rootTraceContext?: unknown;
  };
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
    executionId: task.executionId,
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
    cancellable: kind === "local_agent" ? running && typeof task.executionId === "string" : task.cancellable
  };
}

async function readRuntimeWorkspace(runtime: RuntimeTuiApp["runtime"]): Promise<{
  directory: string;
  branch?: string;
} | undefined> {
  const directory = runtime?.workingDirectory;
  if (!runtime || !directory) return undefined;
  const cached = workspaceSnapshots.get(runtime);
  if (cached?.directory === directory) return await cached.snapshot;
  const snapshot = execFileAsync("git", ["branch", "--show-current"], {
    cwd: directory,
    timeout: 1_000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  }).then(
    ({ stdout }) => ({ directory, branch: stdout.trim() || undefined }),
    () => ({ directory })
  );
  workspaceSnapshots.set(runtime, { directory, snapshot });
  return await snapshot;
}

export async function readTuiRuntimeProjection(
  app: RuntimeTuiApp,
  bridge: RuntimeTuiBridge
): Promise<Record<string, unknown> | null> {
  const executionState = await app.readExecutionState();
  await bridge.$zRestorePersistedBackgroundTasks?.(app);
  const projection = await app.runtime?.getProjection?.();
  if (!projection) return null;
  const live = Object.values(app.runtime?.runtimeTaskRegistry?.all?.() ?? {})
    .filter(task => task.isBackgrounded === true);
  const history = historicalTasks(app).filter(task => !live.some(current =>
    current.taskId === task.taskId && current.status === "running"));
  const details = [...live, ...history].map(taskDetail);
  const tasks: Array<Record<string, unknown>> = Array.isArray(projection.backgroundTasks)
    ? projection.backgroundTasks.map(task => {
      const kind = task.taskKind ?? task.taskType ?? task.type;
      if ((kind === "local_agent" || kind === "agent" || task.toolName === "Agent") && task.status === "running") {
        // A projection can outlive its runner. Only a live detail below grants control.
        return { ...task, status: "owner_unknown", cancellable: false, executionId: undefined };
      }
      return task;
    }) : [];
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
    workspace: await readRuntimeWorkspace(app.runtime),
    backgroundTasks: tasks,
    backgroundTaskDetails: details,
    restoredBackgroundTasks: history.filter(task => ["completed", "failed", "lost"].includes(task.status ?? "")).map(taskDetail)
  };
}

export interface BackgroundTaskMessage {
  taskId: string;
  message: string;
  summary?: string;
  restart?: boolean;
  executionId?: string;
}

export async function stopTuiBackgroundTask(app: RuntimeTuiApp, id: string, executionId?: string): Promise<unknown> {
  const task = app.runtime?.runtimeTaskRegistry?.get?.(id);
  if (!executionId && task?.type !== "local_agent" && !historicalTasks(app).some(row => row.taskId === id)) {
    return app.cancelBackgroundTask?.(id);
  }
  if (!executionId || task?.executionId !== executionId || !app.runtime?.stopBackgroundTask) {
    throw new Error("This agent execution is no longer available to stop.");
  }
  const result = await app.runtime.stopBackgroundTask(id, { expectedExecutionId: executionId, initiator: "user", strict: true });
  if (!result.ok) throw new Error(`Agent stop rejected: ${result.reason}`);
  return result;
}

export async function sendTuiBackgroundTaskMessage(
  app: RuntimeTuiApp,
  bridge: RuntimeTuiBridge,
  input: BackgroundTaskMessage
): Promise<unknown> {
  await bridge.$zRestorePersistedBackgroundTasks?.(app);
  const runtime = app.runtime;
  const local = runtime?.runtimeTaskRegistry?.get?.(input?.taskId);
  const task = local ?? historicalTasks(app).find(row => row.taskId === input?.taskId);
  if (!runtime?.subagentPort?.sendMessage) throw new Error("Background agent messaging is unavailable in this runtime.");
  if (!task || (task.type ?? task.taskType) !== "local_agent") throw new Error("The selected task is not a local agent.");
  if (typeof input?.message !== "string" || !input.message.trim()) throw new Error("Enter a message for the background agent.");
  const message = input.message.trim().slice(0, maximumTaskMessageLength);
  const summary = (typeof input.summary === "string" ? input.summary : message)
    .replace(/\s+/g, " ").trim().slice(0, maximumTaskSummaryLength);
  if (input.restart) await stopTuiBackgroundTask(app, input.taskId, input.executionId);
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
