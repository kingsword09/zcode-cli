const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const bridge = require("../../vendor/cli-config.cjs");

const task = outputFile => ({ outputFile, agentId: "agent-306", childSessionId: "child-306", executionId: crypto.randomUUID() });

if (process.argv[2] === "contender") {
  process.once("message", async output => {
    try {
      await bridge.withSubagentExecution(task(output), true, () => new Promise(resolve => {
        process.send("acquired");
        process.once("message", resolve);
      }));
    } catch (error) {
      process.send(error.message);
    } finally {
      process.disconnect();
    }
  });
} else {
  test("simultaneous cold resumes have one owner and legacy running metadata cannot be claimed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-ownership-"));
    const output = join(directory, "output.txt");
    const metadata = join(directory, "metadata.json");
    const workers = [];
    try {
      await writeFile(metadata, JSON.stringify({ ...task(output), status: "running" }));
      await assert.rejects(bridge.withSubagentExecution(task(output), true, () => assert.fail()), /owner is unknown/);
      assert.equal(bridge.subagentExecutionState(output, task(output).childSessionId), "unknown");
      await writeFile(metadata, JSON.stringify({ ...task(output), status: "completed" }));
      const results = await Promise.all([0, 1].map(async () => {
        const worker = fork(__filename, ["contender"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
        workers.push(worker);
        const response = once(worker, "message");
        worker.send(output);
        return (await response)[0];
      }));
      assert.equal(results.filter(result => result === "acquired").length, 1);
      assert.match(results.find(result => result !== "acquired"), /still owned/);
    } finally {
      await Promise.all(workers.map(async worker => {
        if (worker.exitCode !== null || worker.signalCode !== null) return;
        const exited = once(worker, "exit");
        worker.kill();
        await exited;
      }));
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("stale stop and restart requests never reach the current execution", async () => {
    const calls = [];
    const current = { taskId: "agent", type: "local_agent", status: "running", executionId: "second" };
    const app = { runtime: { runtimeTaskRegistry: { get: () => current },
      stopBackgroundTask: async (...args) => { calls.push(args); return { ok: true }; },
      subagentPort: { sendMessage: () => assert.fail() } } };
    await assert.rejects(bridge.stopTuiBackgroundTask(app, "agent", "first"), /no longer available/);
    await assert.rejects(bridge.sendTuiBackgroundTaskMessage(app, {}, {
      taskId: "agent", executionId: "first", restart: true, message: "continue"
    }), /no longer available/);
    assert.deepEqual(calls, []);
    await bridge.stopTuiBackgroundTask(app, "agent", "second");
    assert.deepEqual(calls, [["agent", { expectedExecutionId: "second", initiator: "user", strict: true }]]);
  });

  test("cold history preserves terminal output and leaves unowned tasks out of the live registry", async () => {
    const registry = { get: () => undefined, all: () => ({}), register: () => assert.fail() };
    const agent = status => ({ agentId: status, childSessionId: status, toolCallId: status,
      subagentType: "general-purpose", title: "fixture", status, summary: "saved result", startedAt: 10 });
    const app = { sessionId: "parent", readExecutionState: () => ({}),
      runtime: { runtimeTaskRegistry: registry, getProjection: () => ({}) },
      readSubagents: async ({ endedCursor }) => endedCursor
        ? { running: [], ended: { items: [agent("failed"), agent("cancelled")] } }
        : { running: [agent("running")], ended: { items: [agent("success"), agent("lost")], nextCursor: "more" } } };
    await bridge.restoreTuiBackgroundTasks(app);
    const projection = await bridge.readTuiRuntimeProjection(app, {});
    assert.deepEqual(Object.fromEntries(projection.backgroundTasks.map(row => [row.agentId, row.status])), {
      running: "owner_unknown", lost: "owner_unknown", success: "completed", failed: "failed", cancelled: "killed"
    });
    assert.ok(projection.backgroundTasks.every(row => row.cancellable === false));
    assert.equal(bridge.historicalTaskOutput(registry, "success").output.content[0].text, "saved result");
    assert.equal(bridge.historicalTaskOutput(registry, "running"), undefined);
  });
}
