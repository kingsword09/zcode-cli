// Test-only access to the native store. No diagnostic API is added to the bundle.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

function loadSessionStore(options = {}) {
  assert.equal(process.versions.bun, undefined, "SQLite runtime tests must execute in real Node.js");
  const file = path.resolve(process.env.ZCODE_TEST_RUNTIME || path.join(__dirname, "../../vendor/zcode.cjs"));
  let source = fs.readFileSync(file, "utf8");
  const store = /([A-Za-z_$][\w$]*)=class(?: [A-Za-z_$][\w$]*)?\{static\{[A-Za-z_$][\w$]*\(this,"SqliteSessionStore"\)/u.exec(source);
  assert.ok(store, "Missing native SqliteSessionStore");
  const init = [...source.slice(0, store.index).matchAll(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\(\)=>\{/gu)].at(-1)?.[1];
  const main = /async function [A-Za-z_$][\w$]*\(\)\{let [A-Za-z_$][\w$]*=process\.argv\.slice\(2\);/u.exec(source);
  assert.ok(init && main, "Missing native store test entry");
  source = source.replace(main[0], `${main[0]}${init}();module.exports=${store[1]};return;`);
  const runtime = new Module(file, module);
  runtime.filename = file;
  runtime.paths = Module._nodeModulePaths(path.dirname(file));
  if (options.recoveryOptions) {
    const nativeRequire = runtime.require.bind(runtime);
    const helperPath = path.join(path.dirname(file), "cli-config.cjs");
    const helper = nativeRequire(helperPath);
    const testHelper = {
      ...helper,
      installSqliteWriteRecovery: store => helper.installSqliteWriteRecovery(store, options.recoveryOptions)
    };
    runtime.require = id => id === helperPath ? testHelper : nativeRequire(id);
  }
  runtime._compile(source, file);
  assert.equal(typeof runtime.exports.openStartup, "function");
  return runtime.exports;
}

function sessionInput(directory, id) {
  return { id, projectID: "sqlite-contention-test", directory, slug: id, title: id, version: "test" };
}

async function worker(mode, options) {
  assert.equal(process.versions.bun, undefined);
  if (mode === "hold") {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(options.dbPath);
    db.exec("BEGIN IMMEDIATE");
    if (options.changeTitleFor) db.prepare("UPDATE session SET title = ? WHERE id = ?").run("uncommitted title", options.changeTitleFor);
    let finished = false;
    let releaseTimer;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      clearTimeout(releaseTimer);
      clearTimeout(watchdog);
      try { db.exec(commit ? "COMMIT" : "ROLLBACK"); }
      finally { db.close(); if (process.connected) process.disconnect(); }
    };
    const watchdog = setTimeout(() => { process.exitCode = 1; finish(false); }, 25_000);
    process.on("disconnect", () => finish(false));
    process.on("message", message => {
      if (message === "release") finish(true);
      if (message === "wait" && !releaseTimer) releaseTimer = setTimeout(() => finish(true), options.holdMs);
    });
    process.send({ type: "ready" });
    return;
  }
  assert.ok(mode === "startup" || mode === "stress");
  await new Promise(resolve => {
    process.once("message", resolve);
    process.send({ type: "ready" });
  });
  const Store = loadSessionStore();
  const store = await Store.openStartup({ dbPath: options.dbPath });
  try {
    assert.equal(store.db.prepare("PRAGMA busy_timeout").get().timeout, 10_000);
    await store.createSession(sessionInput(path.dirname(options.dbPath), options.id));
    if (mode === "stress") {
      for (let index = 0; index < options.turns; index++) {
        const id = `${options.id}-${index}`;
        const now = Date.now();
        await store.saveSessionInput({ id, sessionID: options.id, kind: "prompt", delivery: "queue", payload: { text: id } });
        await store.promoteSessionInput({ id, sessionID: options.id,
          message: { id: `message-${id}`, sessionID: options.id, role: "user", time: { created: now } },
          parts: [{ id: `part-${id}`, messageID: `message-${id}`, sessionID: options.id, type: "text", text: id + "x".repeat(4096) }]
        });
        await store.upsertToolUsage({ id: `usage-${id}`, sessionID: options.id, toolCallID: `tool-${id}`, toolName: "Read", status: "completed", approvalStatus: "none", startedAt: now });
      }
    }
  } finally {
    store.close();
  }
  process.disconnect();
}

module.exports = { loadSessionStore, sessionInput };
if (require.main === module) {
  worker(process.argv[2], JSON.parse(process.argv[3])).catch(error => {
    console.error(error);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}
