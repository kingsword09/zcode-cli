import { expect, test } from "bun:test";
import { isSqliteBusyError } from "../src/runtime-sqlite-connection.ts";
import { pruneSqliteUsage } from "../src/runtime-sqlite-usage.ts";

test("only the SQLite BUSY family is retryable", () => {
  for (const errcode of [5, 261, 517, 773]) expect(isSqliteBusyError({ errcode })).toBe(true);
  for (const errcode of [6, 19, 787, 10, "5", undefined, NaN, 5.1]) expect(isSqliteBusyError({ errcode })).toBe(false);
  expect(isSqliteBusyError(new Error("database is locked"))).toBe(false);
});

test("automatic cleanup skips empty tables, coalesces checks, and preserves explicit requests", () => {
  let checks = 0, cleanups = 0;
  const db = { isTransaction: false, exec() {}, prepare() { return { get() { checks++; return { expired: 0 }; } }; } };
  const prune = () => { cleanups++; };
  for (let i = 0; i < 100; i++) pruneSqliteUsage(db, {}, 10, prune);
  expect(checks).toBe(1);
  expect(cleanups).toBe(0);
  pruneSqliteUsage(db, { beforeTime: 20 }, 20, prune);
  expect(cleanups).toBe(1);
});

test("maintenance BUSY is deferred, but transaction and non-BUSY failures remain visible", () => {
  const busy = Object.assign(new Error("database is locked"), { errcode: 5 });
  const createDb = () => ({ isTransaction: false, exec() {}, prepare() { return { get() { return { expired: 1 }; } }; } });
  const db = createDb();
  let calls = 0;
  const fail = () => { calls++; throw busy; };
  expect(() => pruneSqliteUsage(db, {}, 10, fail)).not.toThrow();
  pruneSqliteUsage(db, {}, 10, fail);
  expect(calls).toBe(1);
  expect(() => pruneSqliteUsage(db, { beforeTime: 10 }, 10, fail)).toThrow(busy);
  const io = Object.assign(new Error("disk I/O error"), { errcode: 10 });
  expect(() => pruneSqliteUsage(createDb(), {}, 10, () => { throw io; })).toThrow(io);
  const open = createDb();
  expect(() => pruneSqliteUsage(open, {}, 10, () => { open.isTransaction = true; throw busy; })).toThrow(busy);
});
