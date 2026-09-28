const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
// Matrix jobs restore the release tarball, which contains the bridge in vendor.
const { restoreTuiBackgroundTasks } = require("../../vendor/cli-config.cjs");

// Load the actual extracted query functions without starting the CLI or a model.
const file = path.resolve(__dirname, "../../vendor/zcode.cjs");
let source = fs.readFileSync(file, "utf8");
const main = /async function [A-Za-z_$][\w$]*\(\)\{let [A-Za-z_$][\w$]*=process\.argv\.slice\(2\);/u.exec(source);
assert.ok(main, "Missing native runtime test entry");
source = source.replace(main[0], `${main[0]}module.exports=${process.argv[2]};return;`);
const runtime = new Module(file, module);
runtime.filename = file;
runtime.paths = Module._nodeModulePaths(path.dirname(file));
runtime._compile(source, file);
const queries = runtime.exports;
assert.equal(typeof queries.projectSubagents, "function");

function fixture({ outcome = "success", events = [], plainText = false, reverted = false, foreign = false } = {}) {
  const childId = "sess_subagent_agent_1";
  const parent = { id: "parent", time: { created: 1, updated: 20 },
    ...(reverted ? { revert: { targetMessageID: "msg-launch", keptMessageIDs: ["msg-before"] } } : {}) };
  const child = { id: childId, parentID: foreign ? "other" : "parent", taskType: "subagent_child", time: { created: 10, updated: 20 } };
  const parentMessages = [
    { info: { id: "msg-before", sessionID: "parent", role: "user", time: { created: 1 } }, parts: [] },
    { info: { id: "msg-launch", sessionID: "parent", role: "assistant", time: { created: 10 } }, parts: [{
      type: "tool", tool: "Agent", callID: "call-1",
      state: { status: "completed", time: { start: 10, end: 11 },
        input: { subagent_type: "Explore", description: "Review", run_in_background: true },
        output: plainText ? "Async agent launched successfully.\nagentId: agent_1 (use SendMessage to continue)"
          : JSON.stringify({ status: "async_launched", agentId: "agent_1", childSessionId: childId, agentType: "Explore" })
      }
    }] }
  ];
  const childMessages = outcome === "running" ? [] : [{
    info: { id: "msg-result", sessionID: childId, role: "assistant", time: { created: 15, completed: 20 },
      ...(outcome === "failed" ? { error: { name: "ProviderError", data: { message: "Provider failed" } } }
        : outcome === "cancelled" ? { error: { name: "AbortError", data: { message: "Cancelled" } } } : {}) },
    parts: [{ type: "text", text: "Review finished" }]
  }];
  const tasks = new Map();
  const app = {
    sessionId: "parent", readExecutionState: () => ({}),
    loadSessionTranscript: async () => { throw new Error("Legacy transcript must not be used"); },
    runtime: {
      sessionStore: {
        getSession: async (id) => id === "parent" ? parent : id === childId ? child : null,
        messages: async ({ sessionID }) => sessionID === "parent" ? parentMessages : childMessages
      },
      getSessionEventStore: () => ({ getEvents: async (id) => id === "parent" ? events : [] }),
      runtimeTaskRegistry: { get: (id) => tasks.get(id), register: (task) => tasks.set(task.taskId, task) }
    }
  };
  return { app, tasks, parentMessages };
}

async function run() {
  for (const [outcome, status] of [["success", "completed"], ["failed", "failed"], ["cancelled", "stopped"], ["running", "running"]]) {
    const { app, tasks } = fixture({ outcome });
    await restoreTuiBackgroundTasks(app, queries);
    assert.equal(tasks.size, 1, `cold resume: ${outcome}`);
    const task = tasks.get("agent_1");
    assert.equal(task.status, status, `cold resume: ${outcome}`);
    assert.equal(task.childSessionId, "sess_subagent_agent_1");
    assert.equal(task.parentToolCallId, "call-1");
    assert.equal(task.agentType, "Explore");
    if (outcome === "success") assert.equal(task.output.content[0].text, "Review finished", "TaskOutput retains the native result summary");
  }
  // Preserve the fixed runtime's read-model behavior for plain-text launch ACKs.
  // It currently reports a failed cold child as completed; status interpretation
  // stays upstream-owned rather than reintroducing local output parsing.
  const plainText = fixture({ outcome: "failed", plainText: true });
  await restoreTuiBackgroundTasks(plainText.app, queries);
  assert.equal(plainText.tasks.get("agent_1")?.status, "completed");
  const activeChild = fixture({ outcome: "running" });
  activeChild.app.runtime.getSessionEventStore = () => ({ getEvents: async (id) => id === "parent" ? [] : [{
    type: "turn_started", sessionId: id, timestamp: new Date(10), payload: { input: "Continue" }
  }] });
  await restoreTuiBackgroundTasks(activeChild.app, queries);
  assert.equal(activeChild.tasks.get("agent_1")?.status, "running", "live child events use the native reducer");
  for (const options of [{ foreign: true }, { reverted: true }]) {
    const { app, tasks } = fixture(options);
    await restoreTuiBackgroundTasks(app, queries);
    assert.equal(tasks.size, 0, JSON.stringify(options));
  }
  const parentEvents = [
    { type: "subagent_spawned", sessionId: "parent", timestamp: new Date(10), payload: {
      agentId: "agent_1", childSessionId: "sess_subagent_agent_1", parentToolCallId: "call-1", agentType: "Explore"
    } },
    { type: "subagent_stopped", sessionId: "parent", timestamp: new Date(20), payload: {
      agentId: "agent_1", childSessionId: "sess_subagent_agent_1", parentToolCallId: "call-1", status: "failed"
    } }
  ];
  const live = fixture({ outcome: "running", events: parentEvents });
  live.parentMessages[1].parts[0].state.output = "Launch acknowledged";
  await restoreTuiBackgroundTasks(live.app, queries);
  assert.equal(live.tasks.get("agent_1")?.status, "failed", "lifecycle events belong to the parent");
  process.stdout.write("Native subagent restoration passed: cold outcomes, active branch, ownership, parent events.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
