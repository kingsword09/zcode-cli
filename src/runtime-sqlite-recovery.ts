import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  installSqliteConnectionWait,
  isSqliteBusyError,
  sqliteOperationScope,
  type RuntimeSqliteConnection,
  type SqliteOperationScope
} from "./runtime-sqlite-connection.ts";

export { pruneSqliteUsage } from "./runtime-sqlite-usage.ts";
export { isSqliteBusyError } from "./runtime-sqlite-connection.ts";

export const sqliteWriteRecoveryPolicy = {
  nativeBusyMs: 25,
  writeBudgetMs: 30_000,
  usageBudgetMs: 30_000,
  initialDelayMs: 10,
  maximumDelayMs: 200
} as const;

// Audited against ZCode 29628c9: native transactions roll back before throwing;
// nontransactional methods upsert/delete stable IDs and preserve input/message sequences.
export const sqliteReplayableWrites = [
  "createSession", "updateSession", "createForkedSessionWithMetadata", "commitForkBundle",
  "commitSharedContextImportBundle", "transitionSharedContextImport", "saveMessage",
  "removeMessage", "savePart", "removePart", "saveSessionEntry", "saveSessionInput",
  "updateSessionInputs", "promoteSessionInput", "markSessionInputPromoted", "settleSessionInput",
  "commitPermissionFullAccess", "updateTodos", "recordInputHistory", "saveProjectPermission",
  "setRevert", "clearRevert"
] as const;

const usageWrites = ["recordModelUsage", "upsertTurnUsage", "upsertToolUsage"] as const;
// These can increment counters or create identities before a later write fails.
// Order them with other writes, but never replay their possibly committed effects.
const orderedWrites = [
  "setTarget", "cloneTargetForFork", "createTarget", "updateTargetStatus", "startTargetRun",
  "heartbeatTargetRun", "finishTargetRun", "recoverInterruptedTargetRun", "accountTargetUsage",
  "updateTargetSummaryTitle", "clearTarget", "claimLegacySessionWorkspace",
  "repairLegacyRemoteSessionWorkspace", "repairRemoteSessionPaths", "upsertScriptWorkflowDefinition",
  "createScriptWorkflowRun", "updateScriptWorkflowRun", "createScriptWorkflowActivity",
  "updateScriptWorkflowActivity", "appendScriptWorkflowEvent", "createSessionTaskLink", "pruneUsage"
] as const;

interface RuntimeSqliteStore {
  db: RuntimeSqliteConnection;
  getDatabasePath(): string;
  close(): void;
}

type StoreMethod = (...args: unknown[]) => unknown;
type Priority = "conversation" | "usage";

interface WriteJob {
  owner: InstalledRecovery;
  priority: Priority;
  run(): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface WriteQueue {
  jobs: WriteJob[];
  active: boolean;
  users: number;
}

export interface SqliteRecoveryStats {
  recoveredWrites: number;
  retries: number;
  exhaustedWrites: number;
  lastRecovery?: { operation: string; attempts: number; elapsedMs: number };
}

interface InstalledRecovery {
  controller: AbortController;
  stats: SqliteRecoveryStats;
}

export interface SqliteRecoveryOptions {
  /** Internal test seam; no new user configuration or environment variables. */
  writeBudgetMs?: number;
  usageBudgetMs?: number;
  nativeBusyMs?: number;
}

const queues = new Map<string | RuntimeSqliteConnection, WriteQueue>();
const installed = new WeakMap<RuntimeSqliteStore, InstalledRecovery>();
const activeConnections = new WeakMap<RuntimeSqliteConnection, SqliteOperationScope>();

export class SqliteWriteRecoveryError extends Error {
  readonly code = "ERR_SQLITE_ERROR";
  readonly errcode: number;

  constructor(
    cause: Error & { errcode: number },
    readonly operation: string,
    readonly attempts: number,
    readonly elapsedMs: number
  ) {
    super(`${cause.message}; SQLite ${operation} exhausted recovery after ${attempts} attempts (${elapsedMs} ms)`, { cause });
    this.name = "SqliteWriteRecoveryError";
    this.errcode = cause.errcode;
  }
}

export function sqliteRecoveryStats(store: RuntimeSqliteStore): SqliteRecoveryStats | undefined {
  const stats = installed.get(store)?.stats;
  return stats ? { ...stats, ...(stats.lastRecovery ? { lastRecovery: { ...stats.lastRecovery } } : {}) } : undefined;
}

function queueKey(store: RuntimeSqliteStore): string | RuntimeSqliteConnection {
  const path = store.getDatabasePath();
  if (path === ":memory:") return store.db;
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function drain(queue: WriteQueue, key: string | RuntimeSqliteConnection): Promise<void> {
  queue.active = true;
  try {
    while (queue.jobs.length) {
      const preferred = queue.jobs.findIndex(job => job.priority === "conversation");
      const [job] = queue.jobs.splice(preferred < 0 ? 0 : preferred, 1);
      try { job!.resolve(await job!.run()); }
      catch (error) { job!.reject(error); }
    }
  } finally {
    queue.active = false;
    if (queue.users === 0) queues.delete(key);
  }
}

async function serviceConversationWrites(queue: WriteQueue): Promise<void> {
  let index: number;
  while ((index = queue.jobs.findIndex(job => job.priority === "conversation")) >= 0) {
    const [job] = queue.jobs.splice(index, 1);
    try { job!.resolve(await job!.run()); }
    catch (error) { job!.reject(error); }
  }
}

/** Install once, after migration; do not replace SQL or the native transaction owner. */
export function installSqliteWriteRecovery(store: RuntimeSqliteStore, options: SqliteRecoveryOptions = {}): void {
  if (installed.has(store)) return;
  const methods = store as unknown as Record<string, unknown>;
  const specifications = [
    ...sqliteReplayableWrites.map(name => ({ name, retry: true, priority: "conversation" as const })),
    ...usageWrites.map(name => ({ name, retry: true, priority: "usage" as const })),
    ...orderedWrites.map(name => ({ name, retry: false, priority: name === "pruneUsage" ? "usage" as const : "conversation" as const }))
  ];
  const originals = specifications.map(spec => {
    const method = methods[spec.name];
    if (typeof method !== "function") throw new Error(`SQLite recovery requires native ${spec.name}.`);
    return { ...spec, method: method as StoreMethod };
  });
  const key = queueKey(store);
  const queue = queues.get(key) ?? { jobs: [], active: false, users: 0 };
  const recovery: InstalledRecovery = {
    controller: new AbortController(),
    stats: { recoveredWrites: 0, retries: 0, exhaustedWrites: 0 }
  };
  installSqliteConnectionWait(store.db);
  queue.users++;
  queues.set(key, queue);
  installed.set(store, recovery);

  const close = store.close.bind(store);
  store.close = () => {
    if (!recovery.controller.signal.aborted) {
      const reason = new Error("SQLite session store closed while waiting for a write.");
      recovery.controller.abort(reason);
      const cancelled = queue.jobs.filter(job => job.owner === recovery);
      queue.jobs = queue.jobs.filter(job => job.owner !== recovery);
      for (const job of cancelled) job.reject(reason);
      queue.users--;
      if (!queue.active && queue.users === 0) queues.delete(key);
    }
    close();
  };

  for (const { name, method, retry, priority } of originals) {
    methods[name] = (...args: unknown[]) => {
      const signal = recovery.controller.signal;
      if (signal.aborted) return Promise.reject(signal.reason);
      const scope = sqliteOperationScope.getStore();
      // Calls within an owned native operation belong to its transaction/retry boundary.
      if (scope?.active && scope.db === store.db) return method.apply(store, args);
      // A transaction opened outside the bridge cannot safely be replayed or queued inside itself.
      if (store.db.isTransaction && !activeConnections.has(store.db)) return method.apply(store, args);
      const startedAt = performance.now();
      const budget = priority === "usage"
        ? options.usageBudgetMs ?? sqliteWriteRecoveryPolicy.usageBudgetMs
        : options.writeBudgetMs ?? sqliteWriteRecoveryPolicy.writeBudgetMs;
      return new Promise((resolve, reject) => {
        queue.jobs.push({ owner: recovery, priority, resolve, reject, run: () => runWrite({
          store, recovery, operation: name, retry, startedAt, deadline: startedAt + budget,
          nativeBusyMs: options.nativeBusyMs ?? sqliteWriteRecoveryPolicy.nativeBusyMs,
          ...(priority === "usage" ? { serviceConversation: () => serviceConversationWrites(queue) } : {}),
          call: () => method.apply(store, args)
        }) });
        if (!queue.active) void drain(queue, key);
      });
    };
  }
}

async function runWrite(input: {
  store: RuntimeSqliteStore;
  recovery: InstalledRecovery;
  operation: string;
  retry: boolean;
  startedAt: number;
  deadline: number;
  nativeBusyMs: number;
  serviceConversation?(): Promise<void>;
  call(): unknown;
}): Promise<unknown> {
  const { store, recovery, operation, startedAt, deadline } = input;
  const signal = recovery.controller.signal;
  let attempts = 0;
  let backoff: number = sqliteWriteRecoveryPolicy.initialDelayMs;
  let lastBusy: (Error & { errcode: number }) | undefined;
  while (true) {
    if (signal.aborted) throw signal.reason;
    if (performance.now() >= deadline) {
      recovery.stats.exhaustedWrites++;
      const elapsed = Math.round(performance.now() - startedAt);
      if (lastBusy) throw new SqliteWriteRecoveryError(lastBusy, operation, attempts, elapsed);
      throw new Error(`SQLite ${operation} waited ${elapsed} ms for preceding writes; no write was attempted.`);
    }
    // A caller can open a transaction after this job was queued. Do not silently
    // join it and acknowledge data that its later rollback would remove.
    if (store.db.isTransaction) {
      await delay(Math.min(backoff, deadline - performance.now()), signal);
      backoff = Math.min(sqliteWriteRecoveryPolicy.maximumDelayMs, backoff * 2);
      await input.serviceConversation?.();
      continue;
    }
    attempts++;
    const scope: SqliteOperationScope = {
      db: store.db, active: true, deadline,
      ...(input.retry ? { nativeBusyMs: input.nativeBusyMs } : {})
    };
    activeConnections.set(store.db, scope);
    try {
      const result = await sqliteOperationScope.run(scope, input.call);
      if (attempts > 1) {
        recovery.stats.recoveredWrites++;
        recovery.stats.lastRecovery = { operation, attempts, elapsedMs: Math.round(performance.now() - startedAt) };
      }
      return result;
    } catch (error) {
      // #162：只有已回滚/幂等的存储动作可重试；仍持事务或其他错误必须原样上抛。
      if (!input.retry || !isSqliteBusyError(error) || store.db.isTransaction) throw error;
      lastBusy = error;
    } finally {
      scope.active = false;
      activeConnections.delete(store.db);
    }
    recovery.stats.retries++;
    const remaining = deadline - performance.now();
    if (remaining <= 0) continue;
    await delay(Math.min(remaining, backoff * (0.5 + Math.random() * 0.5)), signal);
    // A busy usage fact releases priority between attempts, after leaving its transaction.
    // Later usage writes remain queued so stale facts cannot overtake newer updates.
    await input.serviceConversation?.();
    backoff = Math.min(sqliteWriteRecoveryPolicy.maximumDelayMs, backoff * 2);
  }
}
