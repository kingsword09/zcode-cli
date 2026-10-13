import { expect, test } from "bun:test";
import type { RuntimeAdapter } from "../packages/zcode-tui/src/types.ts";
import {
  promptWorkflowConcurrency, requestWorkflowApproval, retuneWorkflow, saveWorkflow, showSavedWorkflows,
  workflowAdjustableSettings, workflowSettingsSummary, type WorkflowDialogs
} from "../packages/zcode-tui/src/workflow-management.ts";
import { workflowRunDetail } from "../packages/zcode-tui/src/dynamic-workflows.ts";
import { createTuiWorkflowManagement, startTuiSavedWorkflow } from "../src/runtime-workflow-bridge.ts";
import { patchRuntimeWorkflowManagement } from "../scripts/runtime-workflow-patches.ts";

function dialogs(choices: (string | null)[], prompts: (string | null)[] = []) {
  const notices: string[] = [];
  const menus: string[][] = [];
  const controls: WorkflowDialogs = {
    choose: async options => {
      menus.push(options.items.map(item => item.value));
      const value = choices.shift();
      if (value === null) return null;
      const selected = options.items.find(item => item.value === value);
      if (!selected) throw new Error(`Unexpected choice ${value} in ${options.title}`);
      return selected;
    },
    prompt: async () => {
      if (!prompts.length) throw new Error("Unexpected input prompt");
      return prompts.shift()!;
    },
    notice: message => { notices.push(message); },
    models: async () => [{ id: "provider/model" }, { id: "disabled/model", disabledReason: "unavailable" }],
    isCurrent: () => true
  };
  return { controls, notices, menus };
}

const request = { toolName: "CreateWorkflow", input: {
  adjustable_settings: { subagent_model: true, concurrency_ceiling: 4 },
  model_bindings: { writer: "other/pinned" }, max_concurrency: 3
} };

test("workflow approval applies only explicit adjustments and preserves per-agent model bindings", async () => {
  const { controls, menus } = dialogs(["concurrency", "model", "provider/model", "allow"], ["0", "2"]);
  expect(await requestWorkflowApproval(request, controls)).toEqual({ decision: "allow", inputAdjustments: { max_concurrency: 2, subagent_model: "provider/model" } });
  expect(menus.flat()).not.toContain("disabled/model");
  expect(workflowSettingsSummary(request.input)).toContain("writer → other/pinned");
  expect(request.input.max_concurrency).toBe(3);
});

test("denying or cancelling a workflow discards edited settings without persistent grants", async () => {
  const changed = dialogs(["concurrency", "deny"], ["2"]);
  expect(await requestWorkflowApproval(request, changed.controls)).toEqual({ decision: "deny", reason: "Workflow approval cancelled" });
  expect(await requestWorkflowApproval(request, dialogs(["allow"]).controls)).toEqual({ decision: "allow" });
  expect(await requestWorkflowApproval(request, dialogs([null]).controls)).toMatchObject({ decision: "deny" });
  expect(changed.menus.flat()).not.toContain("allow_project");
});

test("workflow approval uses null for reset, hides unsupported model controls and respects cancellation", async () => {
  expect(await requestWorkflowApproval(request, dialogs(["concurrency", "model", "default", "allow"], ["default"]).controls))
    .toEqual({ decision: "allow", inputAdjustments: { max_concurrency: null, subagent_model: null } });
  const unsupported = dialogs(["allow"]);
  await requestWorkflowApproval({ ...request, input: { adjustable_settings: { subagent_model: false } } }, unsupported.controls);
  expect(unsupported.menus[0]).not.toContain("model");
  const controller = new AbortController();
  controller.abort();
  expect(await requestWorkflowApproval(request, dialogs([]).controls, undefined, controller.signal)).toMatchObject({ decision: "deny" });
  expect(workflowAdjustableSettings("Bash", request.input)).toBeUndefined();
  expect(workflowAdjustableSettings("CreateWorkflow", {})).toBeUndefined();
});

test("concurrency input rejects fractions, exponent notation and unsafe integers", async () => {
  const state = dialogs([], ["1.5", "1e3", "9007199254740992", "3"]);
  expect(await promptWorkflowConcurrency(state.controls)).toBe(3);
  expect(state.notices).toHaveLength(3);
});

test("retuning calls the live adapter only after explicit consent and discards stale-session actions", async () => {
  const calls: unknown[] = [];
  const adapter = { retuneWorkflowConcurrency: async input => { calls.push(input); return { ok: true }; } } satisfies Partial<RuntimeAdapter>;
  const state = dialogs(["apply"], ["2"]);
  await retuneWorkflow("run", adapter as RuntimeAdapter, state.controls);
  expect(calls).toEqual([{ runId: "run", maxConcurrency: 2 }]);
  await retuneWorkflow("run", adapter as RuntimeAdapter, dialogs(["cancel"], ["4"]).controls);
  const stale = dialogs([], []);
  stale.controls.isCurrent = () => false;
  await retuneWorkflow("run", adapter as RuntimeAdapter, stale.controls);
  expect(calls).toHaveLength(1);
});

test("saving requires overwrite consent and leaves existing definitions intact on cancel", async () => {
  const calls: unknown[] = [];
  const adapter = { saveWorkflowRun: async input => { calls.push(input); return input.overwrite ? { ok: true } : { ok: false, reason: "target_exists" }; } } satisfies Partial<RuntimeAdapter>;
  await saveWorkflow({ runId: "run" }, adapter as RuntimeAdapter, dialogs(["project", "cancel"], ["review", "Review code"]).controls);
  expect(calls).toHaveLength(1);
  await saveWorkflow({ runId: "run" }, adapter as RuntimeAdapter, dialogs(["global", "overwrite"], ["review", "Review code"]).controls);
  expect(calls.at(-1)).toEqual({ runId: "run", name: "review", scope: "global", description: "Review code", overwrite: true });
  await saveWorkflow({ runId: "run" }, adapter as RuntimeAdapter, dialogs([], ["../bad"]).controls);
  expect(calls).toHaveLength(3);
});

test("saved workflow startup preserves scope and JSON argument types and never replays progress", async () => {
  const started: unknown[] = [];
  const adapter = {
    submitPrompt: async () => ({}),
    listSavedWorkflows: async () => ({ workflows: [{ name: "review", scope: "global" }] }),
    readSavedWorkflow: async () => ({ ok: true, meta: { args: { count: { type: "number", required: true } } } }),
    startSavedWorkflow: async input => { started.push(input); return { ok: true, runId: "new-run" }; }
  } satisfies Partial<RuntimeAdapter>;
  await showSavedWorkflows(adapter as RuntimeAdapter, dialogs(["0", "run"], ["[]", '{"count":2,"dry":true}']).controls);
  expect(started).toEqual([{ name: "review", scope: "global", args: { count: 2, dry: true } }]);
  await showSavedWorkflows(adapter as RuntimeAdapter, dialogs(["0", "cancel"], ["{}"]).controls);
  expect(started).toHaveLength(1);
});

test("workflow details show native concurrency and explicit or inherited actor models", () => {
  const detail = workflowRunDetail({ runId: "run", status: "running", concurrency: { cap: 3, limit: 2, ceiling: 4 }, subagentModel: "provider/default",
    actors: [{ name: "writer", model: "other/pinned" }, { name: "reviewer" }] });
  expect(detail).toContain("3 shared · 2 run limit");
  expect(detail).toContain("writer · other/pinned");
  expect(detail).toContain("reviewer · provider/default");
});

test("native workflow management preserves ownership and never replaces terminal runs", async () => {
  const retunes: unknown[] = [], saves: unknown[] = [];
  let task = { parentSessionId: "session", runStatus: "running" };
  const management = createTuiWorkflowManagement({ sessionId: "session", cwd: "/workspace", sessionStore: "store",
    port: { getTask: async () => task, retuneConcurrency: input => { retunes.push(input); return { ok: true }; } },
    native: { list: async params => ({ workflows: [params.scope] }), read: async params => params,
      save: async (context, params) => { saves.push({ context, params }); return { ok: true }; } } });
  expect(await management.retuneWorkflowConcurrency({ runId: "run", maxConcurrency: 2 })).toEqual({ ok: true });
  task.runStatus = "completed";
  expect(await management.retuneWorkflowConcurrency({ runId: "run", maxConcurrency: 3 })).toMatchObject({ reason: "not_live" });
  task.parentSessionId = "other";
  expect(await management.saveWorkflowRun({ runId: "run", name: "review", scope: "project", description: "Review" })).toMatchObject({ reason: "not_found" });
  expect(retunes).toHaveLength(1);
  expect(saves).toHaveLength(0);
  expect(await management.listSavedWorkflows()).toEqual({ workflows: ["project", "global"], invalid: [] });
  await expect(management.retuneWorkflowConcurrency({ runId: "run", maxConcurrency: 1.5 })).rejects.toThrow("positive integer");
  await expect(management.readSavedWorkflow({ name: "review", scope: "invalid" as "project" })).rejects.toThrow("scope");
});

test("workflow patch fails closed when native management anchors are absent", () => {
  expect(() => patchRuntimeWorkflowManagement("unsupported")).toThrow("incompatible");
  const patched = "createTuiWorkflowManagement({";
  expect(patchRuntimeWorkflowManagement(patched)).toBe(patched);
});

test("saved workflow startup respects the native workflow mode gate", async () => {
  const calls: unknown[] = [];
  const app = { runtime: { config: { dynamicWorkflowEnabled: false } }, startSavedWorkflow: async (input: unknown) => { calls.push(input); return { ok: true }; } };
  await expect(startTuiSavedWorkflow(app, { name: "review", scope: "project" })).resolves.toMatchObject({ reason: "workflow_disabled" });
  expect(calls).toHaveLength(0);
  const enabled = { runtime: { config: { dynamicWorkflowEnabled: true } }, startSavedWorkflow: async (input: unknown) => { calls.push(input); return { ok: true }; } };
  await expect(startTuiSavedWorkflow(enabled, { name: "review", scope: "project" })).resolves.toEqual({ ok: true });
  expect(calls).toHaveLength(1);
});
