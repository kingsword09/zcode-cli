const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { loadSessionStore, sessionInput } = require("../fixtures/sqlite-session-store.cjs");
const { withDirectory, startWorker } = require("../fixtures/sqlite-contention.cjs");

assert.equal(process.versions.bun, undefined);
const Store = loadSessionStore();
const runtimeFile = path.resolve(process.env.ZCODE_TEST_RUNTIME || path.join(__dirname, "../../vendor/zcode.cjs"));
const { sqliteRecoveryStats } = require(path.join(path.dirname(runtimeFile), "cli-config.cjs"));

function input(sessionID, id) {
  return { id, sessionID, kind: "prompt", delivery: "queue", payload: { text: id } };
}

function promotion(sessionID, id, text = id) {
  return {
    id, sessionID,
    message: { id: `message-${id}`, sessionID, role: "user", time: { created: Date.now() } },
    parts: [{ id: `part-${id}`, sessionID, messageID: `message-${id}`, type: "text", text }]
  };
}

function usage(id, startedAt = Date.now()) {
  return { id, sessionID: "session", toolCallID: id, toolName: "Read", status: "completed", approvalStatus: "none", startedAt };
}

function interceptRuns(db, beforeRun) {
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    const run = statement.run.bind(statement);
    statement.run = (...args) => { beforeRun(sql.replace(/\s+/gu, " ").trim().toLowerCase(), args); return run(...args); };
    return statement;
  };
  return () => { db.prepare = prepare; };
}

test("lock recovery yields to timers and restores the native timeout", { timeout: 10_000 }, async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    let holder, release, heartbeat;
    try {
      holder = await startWorker("hold", { dbPath });
      let ticks = 0;
      heartbeat = setInterval(() => { ticks++; }, 10);
      release = setTimeout(() => holder.send("release"), 180);
      await store.createSession(sessionInput(directory, "responsive"));
      assert.ok(ticks >= 3, `Event loop blocked during contention: ${ticks} ticks`);
      assert.equal(store.db.prepare("pragma busy_timeout").get().timeout, 10_000);
      assert.ok(sqliteRecoveryStats(store).retries > 0);
      assert.equal(sqliteRecoveryStats(store).lastRecovery.operation, "createSession");
      assert.equal(store.db.prepare("select count(*) AS n from session").get().n, 1);
    } finally {
      clearTimeout(release); clearInterval(heartbeat);
      await holder?.stop(); store.close();
    }
  });
});

test("a write recovers after contention exceeds the former ten-second timeout", { timeout: 25_000 }, async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    let holder;
    try {
      holder = await startWorker("hold", { dbPath, holdMs: 10_500 });
      holder.send("wait");
      const startedAt = performance.now();
      await store.createSession(sessionInput(directory, "long-contention"));
      assert.ok(performance.now() - startedAt >= 10_000);
      assert.equal(store.db.prepare("select count(*) AS n from session").get().n, 1);
      assert.ok(sqliteRecoveryStats(store).lastRecovery.attempts > 1);
      await holder.wait();
    } finally { await holder?.stop(); store.close(); }
  });
});

test("connections in one process serialize an async native transaction without blocking its commit", { timeout: 10_000 }, async () => {
  await withDirectory(async (directory, dbPath) => {
    const first = await Store.openStartup({ dbPath });
    const second = await Store.openStartup({ dbPath });
    try {
      const id = "imported", now = Date.now();
      const importing = first.commitSharedContextImportBundle({
        session: sessionInput(directory, id),
        contextMessage: { info: { id: "context", sessionID: id, role: "user", visibility: "model-only", source: "shared_context", time: { created: now } }, parts: [] },
        provenance: { id: `provenance:${id}`, sessionID: id, type: "v4/shared_context_import", time: { created: now, updated: now }, data: { contextId: id, status: "pending" } }
      });
      assert.equal(first.db.isTransaction, true);
      await Promise.all([importing, second.createSession(sessionInput(directory, "concurrent"))]);
      assert.equal(first.db.isTransaction, false);
      assert.equal(first.db.prepare("select count(*) AS n from session").get().n, 2);
      assert.equal(sqliteRecoveryStats(second).retries, 0);
    } finally { first.close(); second.close(); }
  });
});

test("promotion rolls back a partial write before retrying and commits each message once", async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    try {
      await store.createSession(sessionInput(directory, "session"));
      await store.saveSessionInput(input("session", "prompt"));
      let failed = false, sawPartialWrite = false, rollbacks = 0;
      const execute = store.db.exec.bind(store.db);
      store.db.exec = sql => {
        const result = execute(sql);
        if (sql === "rollback") {
          rollbacks++;
          assert.equal(store.db.prepare("select count(*) AS n from message").get().n, 0);
          assert.equal(store.db.prepare("select count(*) AS n from part").get().n, 0);
        }
        return result;
      };
      interceptRuns(store.db, sql => {
        if (!failed && sql.startsWith("update session_input")) {
          failed = true;
          sawPartialWrite = store.db.prepare("select count(*) AS n from part").get().n === 1;
          throw Object.assign(new Error("injected SQLITE_BUSY"), { errcode: 5, code: "ERR_SQLITE_ERROR" });
        }
      });
      await store.promoteSessionInput(promotion("session", "prompt"));
      assert.equal(sawPartialWrite, true);
      assert.equal(rollbacks, 1);
      assert.equal(store.db.isTransaction, false);
      assert.equal(store.db.prepare("select count(*) AS n from message").get().n, 1);
      assert.equal(store.db.prepare("select count(*) AS n from part").get().n, 1);
      assert.equal(store.db.prepare("select status from session_input").get().status, "promoted");
      assert.equal(sqliteRecoveryStats(store).lastRecovery.attempts, 2);
    } finally { store.close(); }
  });
});

test("idempotent part recovery preserves sequence and cannot overwrite a newer queued update", async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    try {
      await store.createSession(sessionInput(directory, "session"));
      const data = promotion("session", "prompt");
      await store.saveMessage(data.message);
      let failed = false;
      interceptRuns(store.db, sql => {
        if (!failed && sql.startsWith("update session set time_updated")) {
          failed = true;
          throw Object.assign(new Error("busy after part upsert"), { errcode: 5 });
        }
      });
      await Promise.all([
        store.savePart({ ...data.parts[0], text: "older" }),
        store.savePart({ ...data.parts[0], text: "newer" })
      ]);
      const rows = store.db.prepare("select sequence, data from part").all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sequence, 0);
      assert.equal(JSON.parse(rows[0].data).text, "newer");
      assert.equal(sqliteRecoveryStats(store).lastRecovery.operation, "savePart");
    } finally { store.close(); }
  });
});

test("non-BUSY failures and partially committed goal counters are not replayed", async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    try {
      await store.createSession(sessionInput(directory, "session"));
      const fault = Object.assign(new Error("injected constraint failure"), { errcode: 787 });
      const restore = interceptRuns(store.db, sql => { if (sql.startsWith("insert into message")) throw fault; });
      await assert.rejects(store.saveMessage(promotion("session", "prompt").message), error => error === fault);
      assert.equal(sqliteRecoveryStats(store).retries, 0);
      restore();
      const goal = await store.setTarget({ sessionID: "session", objective: "Test accounting", status: "active" });
      const busy = Object.assign(new Error("busy after committed accounting"), { errcode: 5 });
      interceptRuns(store.db, sql => { if (sql.startsWith("update session set time_updated")) throw busy; });
      await assert.rejects(store.accountTargetUsage({ sessionID: "session", targetID: goal.targetID, tokensUsedDelta: 7 }), error => error === busy);
      assert.equal(store.db.prepare("select tokens_used from session_target").get().tokens_used, 7);
      assert.equal(sqliteRecoveryStats(store).retries, 0);
    } finally { store.close(); }
  });
});

test("caller-owned transactions retain rollback ownership and are never replayed", async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    try {
      await store.createSession(sessionInput(directory, "session"));
      const busy = Object.assign(new Error("busy inside caller transaction"), { errcode: 5 });
      const restore = interceptRuns(store.db, sql => { if (sql.startsWith("insert into session_input")) throw busy; });
      store.db.exec("begin immediate");
      await assert.rejects(store.saveSessionInput(input("session", "prompt")), error => error === busy);
      assert.equal(store.db.isTransaction, true);
      assert.equal(sqliteRecoveryStats(store).retries, 0);
      store.db.exec("rollback");
      restore();
      await store.saveSessionInput(input("session", "after-rollback"));
      assert.equal(store.db.prepare("select count(*) AS n from session_input").get().n, 1);
    } finally { if (store.db.isTransaction) store.db.exec("rollback"); store.close(); }
  });
});

test("a caller-owned transaction can finish while another connection waits in the write queue", { timeout: 5_000 }, async () => {
  await withDirectory(async (directory, dbPath) => {
    const owner = await Store.openStartup({ dbPath });
    const waiting = await Store.openStartup({ dbPath });
    try {
      await owner.createSession(sessionInput(directory, "session"));
      owner.db.exec("begin immediate");
      const write = waiting.createSession(sessionInput(directory, "waiting"));
      await owner.saveSessionInput(input("session", "inside-transaction"));
      owner.db.exec("commit");
      await write;
      assert.equal(owner.db.prepare("select count(*) AS n from session").get().n, 2);
      assert.equal(owner.db.prepare("select count(*) AS n from session_input").get().n, 1);
    } finally { if (owner.db.isTransaction) owner.db.exec("rollback"); owner.close(); waiting.close(); }
  });
});

test("a queued write does not join a transaction opened after its submission", { timeout: 5_000 }, async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    try {
      await store.createSession(sessionInput(directory, "session"));
      const preceding = store.upsertToolUsage(usage("preceding"));
      const queued = store.saveSessionInput(input("session", "queued-before-transaction"));
      store.db.exec("begin immediate");
      const rollback = new Promise(resolve => setTimeout(() => { store.db.exec("rollback"); resolve(); }, 60));
      await Promise.all([preceding, queued, rollback]);
      assert.equal(store.db.prepare("select count(*) AS n from session_input").get().n, 1);
    } finally { if (store.db.isTransaction) store.db.exec("rollback"); store.close(); }
  });
});

test("closing a store cancels backoff and queued writes without persisting them", { timeout: 10_000 }, async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    let holder, closed = false;
    try {
      holder = await startWorker("hold", { dbPath });
      const writes = Promise.allSettled([
        store.createSession(sessionInput(directory, "first")),
        store.createSession(sessionInput(directory, "queued"))
      ]);
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.ok(sqliteRecoveryStats(store).retries > 0);
      store.close(); closed = true;
      const results = await writes;
      assert.ok(results.every(result => result.status === "rejected" && /closed/u.test(result.reason.message)));
      holder.send("release"); await holder.wait();
      const reopened = await Store.openStartup({ dbPath });
      try { assert.equal(reopened.db.prepare("select count(*) AS n from session").get().n, 0); }
      finally { reopened.close(); }
    } finally { await holder?.stop(); if (!closed) store.close(); }
  });
});

test("closing one store immediately rejects its queued writes behind a different recovering store", { timeout: 10_000 }, async () => {
  await withDirectory(async (directory, dbPath) => {
    const active = await Store.openStartup({ dbPath });
    const queued = await Store.openStartup({ dbPath });
    let holder, closed = false, deadline;
    try {
      holder = await startWorker("hold", { dbPath });
      const activeWrite = active.createSession(sessionInput(directory, "active"));
      const pending = queued.createSession(sessionInput(directory, "cancelled"));
      const observed = pending.then(() => "written", error => /closed/u.test(error.message) ? "closed" : "unexpected error");
      queued.close(); closed = true;
      assert.equal(await Promise.race([
        observed,
        new Promise(resolve => { deadline = setTimeout(() => resolve("still queued"), 150); })
      ]), "closed");
      holder.send("release");
      await activeWrite;
      assert.deepEqual(active.db.prepare("select id from session").all().map(row => row.id), ["active"]);
    } finally { clearTimeout(deadline); await holder?.stop(); if (!closed) queued.close(); active.close(); }
  });
});

test("usage cleanup retains recent data without a cleanup transaction for every fact", async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    try {
      await store.createSession(sessionInput(directory, "session"));
      // Seed an expired row using the explicit native schema; automatic cleanup is still due.
      store.db.prepare("insert into tool_usage (id,session_id,tool_call_id,tool_name,approval_status,status,started_at) values (?,?,?,?,?,?,?)")
        .run("expired", "session", "expired", "Read", "none", "completed", 1);
      let transactions = 0, deletes = 0;
      const execute = store.db.exec.bind(store.db);
      store.db.exec = sql => { if (sql === "begin immediate") transactions++; return execute(sql); };
      interceptRuns(store.db, sql => { if (/^delete from (model|turn|tool)_usage/u.test(sql)) deletes++; });
      for (let index = 0; index < 100; index++) await store.upsertToolUsage(usage(`current-${index}`));
      assert.equal(transactions, 1);
      assert.equal(deletes, 3);
      assert.equal(store.db.prepare("select count(*) AS n from tool_usage").get().n, 100);
      await store.pruneUsage({ beforeTime: Date.now() + 1 });
      assert.equal(transactions, 2);
      assert.equal(store.db.prepare("select count(*) AS n from tool_usage").get().n, 0);
    } finally { store.close(); }
  });
});

test("queued conversation writes precede usage maintenance and each class remains ordered", async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    try {
      await store.createSession(sessionInput(directory, "session"));
      const order = [];
      interceptRuns(store.db, (sql, args) => {
        if (sql.startsWith("insert into tool_usage") || sql.startsWith("insert into session (")) order.push(args[0]);
      });
      await Promise.all([
        store.upsertToolUsage(usage("usage-1")),
        store.upsertToolUsage(usage("usage-2")),
        store.createSession(sessionInput(directory, "conversation"))
      ]);
      assert.deepEqual(order, ["usage-1", "conversation", "usage-2"]);
    } finally { store.close(); }
  });
});

test("a retrying usage write yields to conversation writes without reordering usage facts", async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    try {
      await store.createSession(sessionInput(directory, "session"));
      const order = [];
      interceptRuns(store.db, (sql, args) => {
        if (sql.startsWith("insert into tool_usage")) {
          if (!order.includes("conversation")) throw Object.assign(new Error("busy usage"), { errcode: 5 });
          order.push(args[0]);
        } else if (sql.startsWith("insert into session (")) order.push(args[0]);
      });
      await Promise.all([
        store.upsertToolUsage(usage("usage-1")),
        store.upsertToolUsage(usage("usage-2")),
        store.createSession(sessionInput(directory, "conversation"))
      ]);
      assert.deepEqual(order, ["conversation", "usage-1", "usage-2"]);
      assert.equal(sqliteRecoveryStats(store).lastRecovery.operation, "upsertToolUsage");
    } finally { store.close(); }
  });
});

test("twelve independent processes preserve inputs, transcripts and usage under sustained writes", { timeout: 60_000 }, async () => {
  await withDirectory(async (_directory, dbPath) => {
    const workers = [], processes = 12, turns = 25;
    try {
      for (let index = 0; index < processes; index++) workers.push(await startWorker("stress", { dbPath, id: `writer-${index}`, turns }));
      for (const worker of workers) worker.send("go");
      await Promise.all(workers.map(worker => worker.wait()));
      const store = await Store.openStartup({ dbPath });
      try {
        for (const table of ["session_input", "message", "part", "tool_usage"]) {
          assert.equal(store.db.prepare(`select count(*) AS n from ${table}`).get().n, processes * turns, table);
        }
        assert.equal(store.db.prepare("select count(*) AS n from session_input where status = 'promoted'").get().n, processes * turns);
        assert.deepEqual(store.db.prepare("pragma foreign_key_check").all(), []);
        assert.equal(store.db.prepare("pragma integrity_check").get().integrity_check, "ok");
      } finally { store.close(); }
    } finally { await Promise.all(workers.map(worker => worker.stop())); }
  });
});
