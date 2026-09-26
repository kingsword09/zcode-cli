import { AsyncLocalStorage } from "node:async_hooks";

export interface RuntimeSqliteStatement {
  get(...values: unknown[]): unknown;
}

export interface RuntimeSqliteConnection {
  readonly isTransaction: boolean;
  exec(sql: string): unknown;
  prepare(sql: string): RuntimeSqliteStatement;
}

export interface SqliteOperationScope {
  db: RuntimeSqliteConnection;
  active: boolean;
  nativeBusyMs?: number;
  deadline: number;
}

export const sqliteOperationScope = new AsyncLocalStorage<SqliteOperationScope>();

export function isSqliteBusyError(error: unknown): error is Error & { errcode: number } {
  if (!error || typeof error !== "object" || !("errcode" in error)) return false;
  const code = error.errcode;
  return typeof code === "number" && Number.isInteger(code) && (code & 0xff) === 5;
}

const guardedConnections = new WeakSet<RuntimeSqliteConnection>();
const statementExecutors = new Set<PropertyKey>(["run", "get", "all"]);

/** Apply short waits only inside an audited operation, without changing other clients of the connection. */
export function installSqliteConnectionWait(db: RuntimeSqliteConnection): void {
  if (guardedConnections.has(db)) return;
  const execute = db.exec.bind(db);
  const prepare = db.prepare.bind(db);
  const readTimeout = prepare("pragma busy_timeout");

  const call = <T>(operation: () => T): T => {
    const scope = sqliteOperationScope.getStore();
    if (!scope?.active || scope.db !== db || scope.nativeBusyMs === undefined) return operation();
    const row = readTimeout.get() as { timeout: number };
    const previous = row.timeout;
    const timeout = Math.min(previous, scope.nativeBusyMs, Math.max(0, Math.floor(scope.deadline - performance.now())));
    if (timeout === previous) return operation();
    execute(`pragma busy_timeout = ${timeout}`);
    let failed = false;
    try {
      return operation();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // #162：不能把短等待留在共享连接上，也不能让恢复 PRAGMA 的错误覆盖原始写入错误。
      try { execute(`pragma busy_timeout = ${previous}`); }
      catch (error) { if (!failed) throw error; }
    }
  };

  db.exec = sql => call(() => execute(sql));
  db.prepare = sql => {
    const statement = call(() => prepare(sql));
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        // Native StatementSync methods require the original receiver, not the proxy.
        return statementExecutors.has(key)
          ? (...args: unknown[]) => call(() => Reflect.apply(value, target, args))
          : value.bind(target);
      }
    });
  };
  guardedConnections.add(db);
}
