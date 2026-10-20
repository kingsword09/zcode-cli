import { describe, expect, test } from "bun:test";
import {
  hasRuntimeSqliteBusyTimeout,
  hasRuntimeSqliteWriteRecovery,
  patchRuntimeSqliteBusyTimeout,
  patchRuntimeSqliteWriteRecovery
} from "../scripts/runtime-sqlite-patches.ts";

function fixture(): string {
  return [
    'const retention=30*86400000;class Store{static async open(t={},n={}){let dbPath="test.sqlite",timeout=5000;const db=t.db;',
    'try{let migration=await migrateAsync(db,dbPath,n??{lockWaitTimeoutMs:timeout});return new Store(db,dbPath,t,migration)}catch(e){try{db.close()}catch{}throw e}}',
    'constructor(db,dbPath,t,migration){this.db=db;this.dbPath=dbPath}',
    'close(){this.db.close()}}',
    'async function prune(db,options={}){let cutoff=options.beforeTime??Date.now()-retention;db.exec("begin immediate");try{',
    'db.prepare("delete from model_usage where started_at < ?").run(cutoff),',
    'db.prepare("delete from turn_usage where started_at < ?").run(cutoff),',
    'db.prepare("delete from tool_usage where started_at < ?").run(cutoff),db.exec("commit")',
    '}catch(error){throw db.exec("rollback"),error}}label(prune,"pruneUsage");'
  ].join("");
}

describe("SQLite recovery bundle boundaries", () => {
  test("installs after the single migration open and preserves the native cleanup cutoff and transaction", async () => {
    const source = patchRuntimeSqliteBusyTimeout(fixture());
    const patched = patchRuntimeSqliteWriteRecovery(source);
    expect(hasRuntimeSqliteBusyTimeout(patched)).toBe(true);
    expect(hasRuntimeSqliteWriteRecovery(patched)).toBe(true);
    expect(patchRuntimeSqliteWriteRecovery(patched)).toBe(patched);
    expect(patchRuntimeSqliteBusyTimeout(patched)).toBe(patched);
    const events: unknown[] = [];
    const db = {
      exec(sql: string) { events.push(sql); },
      prepare(sql: string) { return { run(value: unknown) { events.push([sql, value]); } }; },
      close() { events.push("close"); }
    };
    const helper = {
      installSqliteWriteRecovery(store: { db: unknown }) { expect(store.db).toBe(db); events.push("install"); },
      pruneSqliteUsage(connection: unknown, options: unknown, cutoff: number, run: () => void) {
        expect(connection).toBe(db);
        events.push(["cleanup", options, cutoff]);
        run();
      }
    };
    const run = new Function("require", "__dirname", "migrateAsync", "label", `${patched};return {Store,prune};`)(
      (name: string) => name === "node:path" ? { join: (...parts: string[]) => parts.join("/") } : helper,
      "/fixture", async () => { events.push("async"); }, () => {}
    );
    await run.Store.open({ db });
    expect(events).toEqual(["async", "pragma busy_timeout = 10000", "install"]);
    events.length = 0;
    await run.prune(db, { beforeTime: 42 });
    expect(events).toEqual([
      ["cleanup", { beforeTime: 42 }, 42], "begin immediate",
      ["delete from model_usage where started_at < ?", 42],
      ["delete from turn_usage where started_at < ?", 42],
      ["delete from tool_usage where started_at < ?", 42], "commit"
    ]);
  });

  test("rejects partial patches and unknown cleanup semantics", () => {
    const source = patchRuntimeSqliteBusyTimeout(fixture());
    expect(hasRuntimeSqliteWriteRecovery(source)).toBe(false);
    expect(() => patchRuntimeSqliteWriteRecovery(fixture())).toThrow("post-migration");
    expect(() => patchRuntimeSqliteWriteRecovery(source + source)).toThrow();
    expect(() => patchRuntimeSqliteWriteRecovery(source.replace('"pruneUsage"', '"renamed"'))).toThrow("symbol");
    expect(() => patchRuntimeSqliteWriteRecovery(source.replace("delete from turn_usage", "delete from different_table"))).toThrow("SQL changed");
    const patched = patchRuntimeSqliteWriteRecovery(source);
    const partial = patched.replace(".installSqliteWriteRecovery($zStore)", ".other($zStore)");
    expect(hasRuntimeSqliteWriteRecovery(partial)).toBe(false);
    expect(() => patchRuntimeSqliteWriteRecovery(partial)).toThrow("partial");
  });
});
