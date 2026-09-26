const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadSessionStore, sessionInput } = require("../fixtures/sqlite-session-store.cjs");
const { withDirectory, startWorker } = require("../fixtures/sqlite-contention.cjs");

assert.equal(process.versions.bun, undefined, "Run with npm run test:node / node --test, not bun test");
const Store = loadSessionStore();
const BoundedStore = loadSessionStore({ recoveryOptions: { writeBudgetMs: 250 } });

test("real runtime keeps the write timeout after sync open, async startup and reopen", { timeout: 15_000 }, async t => {
  await withDirectory(async (_directory, dbPath) => {
    const sync = new Store({ dbPath, startupLockTimeoutMs: 750 });
    try { assert.equal(sync.db.prepare("PRAGMA busy_timeout").get().timeout, 10_000); }
    finally { sync.close(); }
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = await Store.openStartup({ dbPath });
      try {
        assert.equal(store.db.prepare("PRAGMA busy_timeout").get().timeout, 10_000);
        assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
        t.diagnostic(`Node ${process.version}; SQLite ${store.db.prepare("SELECT sqlite_version() AS version").get().version}; busy_timeout=10000`);
      } finally { store.close(); }
    }
  });
});

test("a native session write survives a lock held beyond the old five-second window", { timeout: 20_000 }, async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    let holder;
    try {
      assert.equal(store.db.prepare("PRAGMA busy_timeout").get().timeout, 10_000);
      holder = await startWorker("hold", { dbPath, holdMs: 6500 });
      // Keep the held interval independent of the writer's retry scheduling.
      holder.send("wait");
      const startedAt = performance.now();
      await store.createSession(sessionInput(directory, "waited-session"));
      assert.ok(performance.now() - startedAt >= 6000, "The write must overlap the held lock");
      await holder.wait();
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM session WHERE id = ?").get("waited-session").count, 1);
    } finally {
      await holder?.stop();
      store.close();
    }
  });
});

test("lock timeout is bounded, writes nothing, and the same connection works after release", { timeout: 15_000 }, async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await BoundedStore.openStartup({ dbPath });
    let holder;
    try {
      // Shorten both budgets for this failure test; production recovery is exercised above 10 seconds.
      store.db.exec("PRAGMA busy_timeout = 250");
      holder = await startWorker("hold", { dbPath });
      const startedAt = performance.now();
      await assert.rejects(store.createSession(sessionInput(directory, "bounded-session")), error => {
        assert.equal(error.code, "ERR_SQLITE_ERROR");
        assert.equal(error.errcode & 255, 5); // SQLITE_BUSY, not every SQLite error.
        return true;
      });
      assert.ok(performance.now() - startedAt >= 150);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM session").get().count, 0);
      holder.send("release");
      await holder.wait();
      await store.createSession(sessionInput(directory, "bounded-session"));
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM session").get().count, 1);
    } finally {
      await holder?.stop();
      store.close();
    }
  });
});

test("independent processes migrate one fresh database and retain every session write", { timeout: 25_000 }, async () => {
  await withDirectory(async (_directory, dbPath) => {
    const workers = [];
    try {
      for (let index = 0; index < 4; index++) workers.push(await startWorker("startup", { dbPath, id: `concurrent-${index}` }));
      for (const worker of workers) worker.send("go");
      await Promise.all(workers.map(worker => worker.wait()));
      const store = await Store.openStartup({ dbPath });
      try {
        assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM session").get().count, 4);
        const migrations = store.db.prepare("SELECT id, checksum FROM schema_migration").all();
        assert.ok(migrations.length > 0);
        assert.equal(new Set(migrations.map(row => row.id)).size, migrations.length);
        assert.ok(migrations.every(row => typeof row.checksum === "string" && row.checksum.length > 0));
        assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      } finally { store.close(); }
    } finally { await Promise.all(workers.map(worker => worker.stop())); }
  });
});

test("a killed writer releases its lock and uncommitted changes do not survive reopen", { timeout: 15_000 }, async () => {
  await withDirectory(async (directory, dbPath) => {
    let store = await Store.openStartup({ dbPath });
    let holder;
    try {
      await store.createSession(sessionInput(directory, "committed-session"));
      holder = await startWorker("hold", { dbPath, changeTitleFor: "committed-session" });
      await holder.stop("SIGKILL");
      store.close();
      store = undefined;
      store = await Store.openStartup({ dbPath });
      assert.equal(store.db.prepare("SELECT title FROM session WHERE id = ?").get("committed-session").title, "committed-session");
      await store.createSession(sessionInput(directory, "after-crash"));
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM session").get().count, 2);
      assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      await holder?.stop();
      store?.close();
    }
  });
});
