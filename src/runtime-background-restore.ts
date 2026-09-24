import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeTask, RuntimeTuiApp } from "./runtime-tui-bridge.ts";

type RecordValue = Record<string, unknown>;
const maximumReminderTasks = 32;
const maximumReminderLength = 4_000;
const maximumRestoredTasks = 64;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseSpawn(output: string, input: RecordValue | undefined): RecordValue | undefined {
  try {
    const parsed = record(JSON.parse(output));
    if (parsed) return parsed;
  } catch {
    // Older runtimes returned a formatted launch result rather than JSON.
  }
  if (!output.includes("Async agent launched successfully.")) return undefined;
  const agentId = /(?:^|\n)agentId:\s*([^\s(]+)/u.exec(output)?.[1];
  if (!agentId) return undefined;
  return {
    status: "async_launched", agentId,
    agentType: text(input?.subagent_type) ?? text(input?.agentType),
    childSessionId: `sess_subagent_${agentId}`,
    description: text(input?.description), prompt: text(input?.prompt),
    outputFile: /(?:^|\n)output_file:\s*([^\r\n]+)/u.exec(output)?.[1]?.trim()
  };
}

async function readMetadata(outputFile: unknown): Promise<RecordValue | undefined> {
  if (!text(outputFile)) return undefined;
  try {
    return record(JSON.parse(await readFile(join(dirname(outputFile as string), "metadata.json"), "utf8")));
  } catch {
    // Metadata is optional; the persisted launch result still restores a task.
    return undefined;
  }
}

function enrichSpawn(spawn: RecordValue, metadata: RecordValue | undefined, sessionId: string): RecordValue {
  if (!metadata || typeof metadata.agentId === "string" && metadata.agentId !== spawn.agentId
    || typeof metadata.parentSessionId === "string" && metadata.parentSessionId !== sessionId) return spawn;
  return {
    ...spawn,
    agentType: text(metadata.profileId) ?? spawn.agentType,
    childSessionId: text(metadata.childSessionId) ?? spawn.childSessionId,
    description: text(metadata.description) ?? spawn.description,
    outputFile: text(metadata.outputFile) ?? spawn.outputFile,
    prompt: text(metadata.prompt) ?? spawn.prompt,
    error: text(metadata.error) ?? spawn.error
  };
}

async function restore(app: RuntimeTuiApp): Promise<void> {
  const runtime = app.runtime;
  const registry = runtime?.runtimeTaskRegistry;
  const sessionId = app.sessionId;
  if (!registry?.register || typeof sessionId !== "string" || sessionId === app.$zRestoredBackgroundTasksSession) return;
  app.$zRestoredBackgroundTasksSession = sessionId;
  app.$zRestoredBackgroundTasksLog = [];
  try {
    const messages = await app.loadSessionTranscript?.() ?? [];
    const restored: RuntimeTask[] = [];
    for (const messageValue of messages) {
      const parts = record(messageValue)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const value of parts) {
        const part = record(value);
        if (part?.type !== "tool") continue;
        const tool = (typeof part.toolName === "string" ? part.toolName
          : typeof part.tool === "string" ? part.tool : "").trim().toLowerCase();
        if (!["agent", "subagent", "task"].includes(tool)) continue;
        const state = record(part.state);
        const output = typeof part.output === "string" ? part.output : state?.output;
        if (typeof output !== "string" || !output.trim()) continue;
        let spawn = parseSpawn(output, record(part.input ?? state?.input));
        if (!spawn || !["async_launched", "backgrounded"].includes(String(spawn.status)) || !text(spawn.agentId)) continue;
        const metadata = await readMetadata(spawn.outputFile);
        spawn = enrichSpawn(spawn, metadata, sessionId);
        const agentId = spawn.agentId as string;
        if (registry.get?.(agentId)) continue;
        const task: RuntimeTask = {
          taskId: agentId, agentId,
          agentType: text(spawn.agentType) ?? "general-purpose",
          childSessionId: text(spawn.childSessionId) ?? `sess_subagent_${agentId}`,
          description: text(spawn.description), error: text(spawn.error),
          isBackgrounded: true, outputFile: text(spawn.outputFile),
          parentToolCallId: text(part.toolCallId) ?? text(part.callID),
          parentSessionId: sessionId, prompt: text(spawn.prompt),
          startedAt: record(state?.time)?.start,
          status: metadata?.status === "completed" ? "completed" : metadata?.status === "failed" ? "failed" : "stopped",
          taskType: "local_agent", type: "local_agent"
        };
        registry.register(task);
        restored.push(task);
      }
    }
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
    app.$zRestoredBackgroundTasksSession = undefined;
  }
}

const pendingRestores = new WeakMap<RuntimeTuiApp, Promise<void>>();

export async function restoreTuiBackgroundTasks(app: RuntimeTuiApp): Promise<void> {
  const pending = pendingRestores.get(app);
  if (pending) return pending;
  const operation = restore(app);
  pendingRestores.set(app, operation);
  try { await operation; }
  finally { pendingRestores.delete(app); }
}
