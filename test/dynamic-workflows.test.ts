import { expect, test } from "bun:test";
import { DynamicWorkflows, workflowRunDetail } from "../packages/zcode-tui/src/dynamic-workflows.ts";
import { patchRuntimeWorkflowReducer } from "../scripts/sync-runtime.ts";

test("workflow bridge exposes the native reducer and is idempotent", () => {
  const source = 'var init=boot(()=>{label(reduce,"reduceWorkflowRunsState")});function reduce(state,event){return{state,event}};const opts={replayWorkflowRuns:handler.replayWorkflowRuns};';
  const patched = patchRuntimeWorkflowReducer(source);
  expect(patchRuntimeWorkflowReducer(patched)).toBe(patched);
  let initialized = false;
  const options = new Function("boot", "label", "handler", `${patched};return opts`)(
    (fn: () => void) => () => { initialized = true; fn(); }, () => {}, {}
  );
  expect(options.reduceWorkflowRuns("state", "event")).toEqual({ state: "state", event: "event" });
  expect(initialized).toBeTrue();
  expect(() => patchRuntimeWorkflowReducer("unsupported")).toThrow("incompatible");
});

test("replay precedes live updates and duplicate sequences do not regress progress", async () => {
  let release!: (value: unknown) => void;
  const sequences: number[] = [];
  const workflows = new DynamicWorkflows({
    listWorkflowRuns: async () => [{ runId: "run", label: "Review", status: "stopped", resumable: true }],
    replayWorkflowRuns: () => new Promise((resolve) => { release = resolve; }),
    reduceWorkflowRuns: (_state, value) => {
      const event = value as { sequence: number };
      sequences.push(event.sequence);
      return { runs: [{ runId: "run", status: "running", resumable: false }] };
    }
  });
  const hydration = workflows.hydrate();
  await Promise.resolve();
  workflows.accept({ runId: "run", sequence: 2, eventType: "run-started" });
  release([{ runId: "run", sequence: 1, eventType: "run-started" }]);
  await hydration;
  workflows.accept({ runId: "run", sequence: 1, eventType: "run-settled" });
  expect(sequences).toEqual([1, 2]);
  expect(workflows.runs()[0]).toMatchObject({ label: "Review", status: "running", resumable: false });
});

test("reset rejects late old-session hydration and exposes recoverable errors", async () => {
  let release!: (value: unknown) => void;
  const workflows = new DynamicWorkflows({ listWorkflowRuns: () => new Promise((resolve) => { release = resolve; }) });
  const hydration = workflows.hydrate();
  await Promise.resolve();
  workflows.reset();
  release([{ runId: "old", status: "completed" }]);
  await hydration;
  expect(workflows.runs()).toEqual([]);
  const failing = new DynamicWorkflows({ listWorkflowRuns: async () => { throw new Error("Store unavailable"); } });
  await failing.hydrate();
  expect(failing.error).toContain("/workflows to retry");
});

test("a resumed run replaces synthetic interrupted replay at the same sequence", async () => {
  const events: string[] = [];
  const workflows = new DynamicWorkflows({
    replayWorkflowRuns: async () => [{ runId: "run", sequence: 2, eventType: "run-settled", payload: { resumable: true } }],
    reduceWorkflowRuns: (_state, value) => {
      const event = value as { eventType: string };
      events.push(event.eventType);
      return { runs: [{ runId: "run", status: event.eventType === "run-started" ? "running" : "stopped" }] };
    }
  });
  await workflows.hydrate();
  const start = { runId: "run", sequence: 2, eventType: "run-started", payload: {} };
  workflows.accept(start);
  workflows.accept(start);
  expect(events).toEqual(["run-settled", "run-started"]);
  expect(workflows.runs()[0]?.status).toBe("running");
});

test("details use observed counts and sanitize runtime text", () => {
  const detail = workflowRunDetail({ runId: "run", label: "Review\x1b[31m", status: "running",
    nodes: [{ phase: "settled" }, { phase: "executing" }], usage: { spentTokens: 123 },
    artifacts: [{ title: "report.md" }], actors: [{ name: "Reviewer", status: "working" }] });
  expect(detail).toContain("1/2 observed steps settled");
  expect(detail).toContain("123");
  expect(detail).toContain("report.md");
  expect(detail).not.toContain("\x1b");
});
