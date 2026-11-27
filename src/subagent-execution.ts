import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

interface Execution {
  childSessionId: string;
  outputFile: string;
  agentId: string;
  executionId: string;
}

const active = new AsyncLocalStorage<{ retain(): () => void }>();

function lockPath(output: string, child: string): string {
  const key = createHash("sha256").update(child).digest("hex");
  return join(dirname(output), `execution-${key}.sqlite`);
}

function busy(error: unknown): boolean {
  const code = (error as { errcode?: number })?.errcode;
  return code === 5 || code === 6;
}

function openDatabase(path: string, readOnly = false): DatabaseSync {
  const sqlite: typeof import("node:sqlite") = require("node:sqlite");
  return new sqlite.DatabaseSync(path, { readOnly });
}

interface RunRecord {
  agentId: string;
  childSessionId: string;
  executionId?: string;
  status: string;
}

export function readSubagentRun(output: string | undefined, child: string, agent?: string): RunRecord | undefined {
  if (!output) return;
  try {
    const run = JSON.parse(readFileSync(join(dirname(output), "metadata.json"), "utf8"));
    if (run?.childSessionId === child && (!agent || run.agentId === agent)) return run;
  } catch { /* A legacy or partially written record cannot establish an owner. */ }
}

function previousExecution(db: DatabaseSync): unknown {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution'").get()) return;
  return db.prepare("SELECT id FROM execution WHERE singleton=1").get()?.id;
}

export function subagentExecutionState(output?: string, child?: string): "held" | "released" | "unknown" {
  if (!output || !child) return "unknown";
  const path = lockPath(output, child);
  if (!existsSync(path)) return "unknown";
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(path, true);
    const generation = previousExecution(db);
    return generation && generation === readSubagentRun(output, child)?.executionId ? "released" : "unknown";
  } catch (error) {
    return busy(error) ? "held" : "unknown";
  } finally {
    db?.close();
  }
}

export async function withSubagentExecution<T>(task: Execution, resume: boolean, work: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(task.outputFile), { recursive: true });
  const db = openDatabase(lockPath(task.outputFile, task.childSessionId));
  let references = 1;
  const release = () => { if (--references === 0) db.close(); };
  try {
    // EXCLUSIVE locking mode retains the OS lock across COMMIT. The marker is
    // durable before the model starts and a killed process drops its lock.
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    if (resume) {
      const metadata = readSubagentRun(task.outputFile, task.childSessionId, task.agentId);
      const generation = previousExecution(db);
      if (!metadata || (!["completed", "failed", "stopped"].includes(metadata.status) &&
          !(metadata.status === "running" && generation && generation === metadata.executionId))) {
        throw new Error("Cannot resume this agent because its previous execution owner is unknown.");
      }
    }
    db.exec("CREATE TABLE IF NOT EXISTS execution (singleton INTEGER PRIMARY KEY, id TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO execution VALUES (1, ?)").run(task.executionId);
    db.exec("COMMIT");
  } catch (error) {
    db.close();
    if (busy(error)) throw new Error("This agent execution is still owned by a runtime.");
    throw error;
  }
  try {
    return await active.run({ retain() { references++; return release; } }, work);
  } finally {
    release();
  }
}

// The native port tracks both detached finalization and the underlying child
// promise (which can outlive cancellation). Keep the lock until both settle.
export function trackSubagentExecution(work: Promise<unknown>): void {
  const release = active.getStore()?.retain();
  if (release) void work.then(release, release);
}
