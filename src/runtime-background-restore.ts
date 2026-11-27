import { readSubagentRun, subagentExecutionState } from "./subagent-execution.ts";
import type { RuntimeTask, RuntimeTuiApp } from "./runtime-tui-bridge.ts";

const history = new WeakMap<object, Map<string, RuntimeTask>>();
const reads = new WeakMap<object, { session: string; time: number; pending: Promise<void> }>();

export function historicalTaskOutput(registry: object, id: string): RuntimeTask | undefined {
  const task = history.get(registry)?.get(id);
  return task && ["completed", "failed", "killed"].includes(task.status ?? "") ? task : undefined;
}

export function historicalTasks(app: RuntimeTuiApp): RuntimeTask[] {
  const registry = app.runtime?.runtimeTaskRegistry;
  return registry ? [...(history.get(registry)?.values() ?? [])] : [];
}

async function readHistory(app: RuntimeTuiApp, session: string): Promise<void> {
  const runtime = app.runtime;
  const registry = runtime?.runtimeTaskRegistry;
  if (!app.readSubagents || !registry) return;
  const tasks = new Map<string, RuntimeTask>();
  let cursor: string | undefined;
  do {
    const page = await app.readSubagents({ endedCursor: cursor, endedLimit: 100 });
    for (const agent of [...page.running, ...page.ended.items]) {
      const id = agent.agentId ?? agent.toolCallId;
      const live = registry.get?.(id);
      if (live?.status === "running") continue;
      const output = runtime.transcriptAgentOutputFiles?.get(id) ??
        (typeof live?.outputFile === "string" ? live.outputFile : undefined);
      const owner = subagentExecutionState(output, agent.childSessionId);
      const run = readSubagentRun(output, agent.childSessionId, id);
      const savedTerminal = run && { completed: "completed", failed: "failed", stopped: "killed" }[run.status];
      const projectedTerminal = { success: "completed", failed: "failed", cancelled: "killed" }[agent.status];
      let status = savedTerminal ?? projectedTerminal ?? "owner_unknown";
      if (owner === "held") status = "running_elsewhere";
      else if (run?.status === "running" || !savedTerminal && !projectedTerminal) {
        status = owner === "released" ? "lost" : "owner_unknown";
      }
      if (live && (live.status === status || live.executionId === run?.executionId && run?.executionId)) continue;
      tasks.set(id, {
        taskId: id, agentId: id, agentType: agent.subagentType, type: "local_agent",
        childSessionId: agent.childSessionId, parentSessionId: session, parentToolCallId: agent.toolCallId,
        description: agent.title, isBackgrounded: true, status, outputFile: output,
        cancellable: false, startedAt: agent.startedAt, completedAt: agent.endedAt,
        error: status === "failed" ? agent.summary : undefined,
        output: status === "completed" && agent.summary
          ? { status: "completed", content: [{ type: "text", text: agent.summary }] } : undefined
      });
    }
    cursor = page.ended.nextCursor;
  } while (cursor);
  if (app.sessionId === session && app.runtime === runtime) history.set(registry, tasks);
}

export async function restoreTuiBackgroundTasks(app: RuntimeTuiApp): Promise<void> {
  const session = app.sessionId;
  const registry = app.runtime?.runtimeTaskRegistry;
  if (!session || !registry) return;
  const read = reads.get(registry);
  if (read?.session === session && Date.now() - read.time < 2000) {
    const releasedSinceRead = historicalTasks(app).some(task => task.status === "running_elsewhere" &&
      subagentExecutionState(task.outputFile as string, task.childSessionId as string) !== "held");
    if (read.time === Infinity || !releasedSinceRead) return read.pending;
  }
  if (read?.session !== session) history.delete(registry);
  const entry = { session, time: Infinity, pending: Promise.resolve() };
  reads.set(registry, entry);
  entry.pending = readHistory(app, session).then(() => { entry.time = Date.now(); }, () => {
    if (reads.get(registry) === entry) reads.delete(registry);
  });
  return entry.pending;
}
