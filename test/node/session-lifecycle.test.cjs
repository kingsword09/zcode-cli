const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { loadSessionStore } = require("../fixtures/sqlite-session-store.cjs");
const { loadSessionLifecycle } = require("../fixtures/session-lifecycle-runtime.cjs");

const Store = loadSessionStore();
const lifecycle = loadSessionLifecycle();
const helper = require("../../vendor/cli-config.cjs");

function runtime(store, directory) {
  return {
    sessionId: "sess_native_lifecycle", sessionPersisted: false, sessionStore: store,
    // 0.17.1 writes recorded session features after the first persist.
    sessionFeatures: new Set(), sessionFeaturesWrite: Promise.resolve(),
    workingDirectory: directory, appVersion: "test", config: { taskType: "interactive", mode: "build" },
    rootTraceContext: { traceId: "trace_native_lifecycle" },
    getSessionModelSelection: () => undefined,
    createEvent: (type, payload) => ({ type, payload }),
    appendEvent: async () => {},
    persistSession: lifecycle.persistSession,
    ensureSessionPersisted: lifecycle.ensureSessionPersisted,
    ensureSessionPersistedForExternalActivity: lifecycle.ensureSessionPersistedForExternalActivity,
    setCustomSessionTitle: lifecycle.setCustomSessionTitle
  };
}

test("native persistence merges concurrent requests and saves a custom title without messages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zcode-native-lifecycle-"));
  const store = await Store.openStartup({ dbPath: path.join(directory, "db.sqlite") });
  try {
    const app = runtime(store, directory);
    let creates = 0;
    const create = store.createSession.bind(store);
    store.createSession = async input => { creates++; return create(input); };
    assert.equal(await helper.readSessionResumeTarget({ runtime: app }), undefined);
    await Promise.all([
      app.setCustomSessionTitle({ title: "Chosen title", traceContext: app.rootTraceContext }),
      app.ensureSessionPersistedForExternalActivity("First prompt", { traceContext: app.rootTraceContext })
    ]);
    assert.equal(creates, 1);
    assert.equal(app.sessionPersisted, true);
    assert.equal(await helper.readSessionResumeTarget({ runtime: app }), app.sessionId);
    assert.equal((await store.getSession(app.sessionId)).title, "Chosen title");
    assert.equal((await store.getSession(app.sessionId)).titleSource, "custom");
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM message WHERE session_id = ?").get(app.sessionId).count, 0);
    await app.ensureSessionPersistedForExternalActivity("Later prompt", { traceContext: app.rootTraceContext });
    assert.equal(creates, 1);
    assert.equal((await store.getSession(app.sessionId)).title, "Chosen title");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native persistence failure is retryable and does not claim a custom title was saved", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zcode-native-lifecycle-retry-"));
  const store = await Store.openStartup({ dbPath: path.join(directory, "db.sqlite") });
  try {
    const app = runtime(store, directory);
    const create = store.createSession.bind(store);
    store.createSession = async () => { throw new Error("Injected write failure"); };
    await assert.rejects(app.setCustomSessionTitle({ title: "Failed title", traceContext: app.rootTraceContext }), /Injected write failure/);
    assert.equal(app.sessionPersisted, false);
    assert.equal(await store.getSession(app.sessionId), null);
    store.createSession = create;
    await app.setCustomSessionTitle({ title: "Retry title", traceContext: app.rootTraceContext });
    assert.equal(app.sessionPersisted, true);
    assert.equal((await store.getSession(app.sessionId)).title, "Retry title");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed custom title write preserves the stored title and can be retried", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zcode-native-title-retry-"));
  const store = await Store.openStartup({ dbPath: path.join(directory, "db.sqlite") });
  try {
    const app = runtime(store, directory);
    await app.setCustomSessionTitle({ title: "Original title", traceContext: app.rootTraceContext });
    const update = store.updateSession.bind(store);
    store.updateSession = async () => { throw new Error("Injected title failure"); };
    await assert.rejects(app.setCustomSessionTitle({ title: "Failed title", traceContext: app.rootTraceContext }), /Injected title failure/);
    assert.equal((await store.getSession(app.sessionId)).title, "Original title");
    store.updateSession = update;
    await app.setCustomSessionTitle({ title: "Retried title", traceContext: app.rootTraceContext });
    assert.equal((await store.getSession(app.sessionId)).title, "Retried title");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
