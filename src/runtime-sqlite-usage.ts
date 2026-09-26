import { isSqliteBusyError, type RuntimeSqliteConnection } from "./runtime-sqlite-connection.ts";

export const sqliteUsageCleanupIntervalMs = 5 * 60_000;
export const sqliteUsageCleanupRetryMs = 1_000;

const nextCleanup = new WeakMap<RuntimeSqliteConnection, number>();
const expiredUsageQuery = `select
  exists(select 1 from model_usage where started_at < ?) or
  exists(select 1 from turn_usage where started_at < ?) or
  exists(select 1 from tool_usage where started_at < ?) as expired`;

/** The native function still supplies the cutoff and owns the cleanup transaction. */
export function pruneSqliteUsage(
  db: RuntimeSqliteConnection,
  options: { beforeTime?: number },
  beforeTime: number,
  prune: () => void
): void {
  if (options.beforeTime !== undefined) {
    prune();
    return;
  }
  const now = performance.now();
  if (now < (nextCleanup.get(db) ?? 0)) return;
  // A caller-owned transaction must not gain a nested maintenance transaction.
  if (db.isTransaction) {
    nextCleanup.set(db, now + sqliteUsageCleanupRetryMs);
    return;
  }
  try {
    const row = db.prepare(expiredUsageQuery).get(beforeTime, beforeTime, beforeTime) as { expired: number };
    if (row.expired) prune();
    nextCleanup.set(db, performance.now() + sqliteUsageCleanupIntervalMs);
  } catch (error) {
    // #162：用量 UPSERT 已提交；清理抢锁失败不能重放这个事实或拖住主回合。
    if (!isSqliteBusyError(error) || db.isTransaction) throw error;
    nextCleanup.set(db, performance.now() + sqliteUsageCleanupRetryMs);
  }
}
