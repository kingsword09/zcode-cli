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

test("recovery requires the native message bundle transaction", async () => {
  await withDirectory(async (directory, dbPath) => {
    const commitMessageBundle = Store.prototype.commitMessageBundle;
    Store.prototype.commitMessageBundle = undefined;
    try {
      await assert.rejects(Store.openStartup({ dbPath }), /SQLite recovery requires native commitMessageBundle/);
    } finally { Store.prototype.commitMessageBundle = commitMessageBundle; }
  });
});

test("lock recovery yields to timers and restores the native timeout", { timeout: 10_000 }, async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    let holder, release, releaseSent = false;
    try {
      holder = await startWorker("hold", { dbPath });
      release = setTimeout(() => { releaseSent = true; holder.send("release"); }, 180);
      await store.createSession(sessionInput(directory, "responsive"));
      assert.equal(releaseSent, true, "Contention release timer did not run before the write completed");
      assert.equal(store.db.prepare("pragma busy_timeout").get().timeout, 10_000);
      assert.ok(sqliteRecoveryStats(store).retries > 0);
      assert.equal(sqliteRecoveryStats(store).lastRecovery.operation, "createSession");
      assert.equal(store.db.prepare("select count(*) AS n from session").get().n, 1);
    } finally {
      clearTimeout(release);
      await holder?.stop(); store.close();
    }
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

test("message bundles roll back partial writes before retrying without duplicating records", async () => {
  await withDirectory(async (directory, dbPath) => {
    const store = await Store.openStartup({ dbPath });
    try {
      await store.createSession(sessionInput(directory, "session"));
      const first = promotion("session", "first"), second = promotion("session", "second");
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
        if (!failed && sql.startsWith("insert into message")
          && store.db.prepare("select count(*) AS n from part").get().n === 1) {
          failed = true;
          sawPartialWrite = true;
          throw Object.assign(new Error("busy during message bundle"), { errcode: 5 });
        }
      });
      await store.commitMessageBundle({
        sessionID: "session",
        messages: [first, second].map(data => ({ info: data.message, parts: data.parts }))
      });
      assert.equal(sawPartialWrite, true);
      assert.equal(rollbacks, 1);
      assert.equal(store.db.isTransaction, false);
      assert.equal(store.db.prepare("select count(*) AS n from message").get().n, 2);
      assert.equal(store.db.prepare("select count(*) AS n from part").get().n, 2);
      assert.equal(sqliteRecoveryStats(store).lastRecovery.operation, "commitMessageBundle");
      assert.equal(sqliteRecoveryStats(store).lastRecovery.attempts, 2);
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
