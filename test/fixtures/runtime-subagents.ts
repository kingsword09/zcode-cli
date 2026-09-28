import type { RuntimeSessionInfo, RuntimeSubagent, RuntimeSubagentQueries, RuntimeTask, RuntimeTuiApp } from "../../src/runtime-tui-bridge.ts";

// Stub only the native projection. Real runtime semantics are covered by the
// Node integration fixture in subagent-restoration.cjs.
export const fixtureSubagentQueries: RuntimeSubagentQueries = {
  collectChildSessionIds: (_session, messages) => (messages as RuntimeSubagent[]).map((agent) => agent.childSessionId),
  projectChildEvents: (events) => ({ events }),
  projectSubagents: ({ messages, childSessionsById }) => {
    const agents = (messages as RuntimeSubagent[]).filter((agent) => childSessionsById.has(agent.childSessionId));
    return {
      running: agents.filter((agent) => agent.status === "running"),
      ended: agents.filter((agent) => agent.status !== "running")
    };
  }
};

export function subagentRestoreFixture(status = "success") {
  const agent: RuntimeSubagent = {
    agentId: "agent", childSessionId: "child", toolCallId: "call",
    subagentType: "Explore", title: "Review", status, startedAt: 10, endedAt: 20
  };
  const sessions = new Map<string, RuntimeSessionInfo>([
    ["parent", { id: "parent" }],
    ["child", { id: "child", parentID: "parent", taskType: "subagent_child" }]
  ]);
  const tasks = new Map<string, RuntimeTask>();
  const reminders: string[] = [];
  const app: RuntimeTuiApp = {
    sessionId: "parent", readExecutionState: () => ({}),
    runtime: {
      sessionStore: {
        getSession: async (id) => sessions.get(id) ?? null,
        messages: async ({ sessionID }) => sessionID === "parent" ? [agent] : []
      },
      getSessionEventStore: () => ({ getEvents: async () => [] }),
      runtimeTaskRegistry: {
        get: (id) => tasks.get(id), register: (task) => tasks.set(task.taskId, task)
      },
      messageHistory: { addAttachment: (_source, text) => reminders.push(text) }
    }
  };
  return { app, agent, sessions, tasks, reminders };
}
