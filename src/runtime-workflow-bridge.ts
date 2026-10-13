export type WorkflowScope = "project" | "global";

export async function startTuiSavedWorkflow(app: {
  runtime?: { config?: { dynamicWorkflowEnabled?: boolean } };
  startSavedWorkflow?(input: unknown): Promise<unknown>;
}, input: { name: string; scope: WorkflowScope; args?: Record<string, unknown> }) {
  if (app.runtime?.config?.dynamicWorkflowEnabled !== true) {
    return { ok: false, reason: "workflow_disabled", message: "Restart with --workflow-mode alwaysOn or onDemand to run workflows." };
  }
  if (input.scope !== "project" && input.scope !== "global") throw new Error("Choose project or global workflow scope.");
  if (!app.startSavedWorkflow) return { ok: false, reason: "unsupported" };
  return await app.startSavedWorkflow(input);
}

interface NativeWorkflowManagement {
  port: {
    getTask(runId: string): Promise<{ parentSessionId?: string; status?: string; runStatus?: string } | undefined>;
    retuneConcurrency?(input: { runId: string; maxConcurrency: number | null }): unknown;
  };
  sessionId: string;
  cwd: string;
  sessionStore: unknown;
  native: {
    list(params: Record<string, unknown>): Promise<unknown>;
    read(params: Record<string, unknown>): Promise<unknown>;
    save(context: unknown, params: Record<string, unknown>): Promise<unknown>;
  };
}

export function createTuiWorkflowManagement(deps: NativeWorkflowManagement) {
  const workspace = { workspacePath: deps.cwd, workspaceKey: deps.cwd };
  const scope = (value: unknown): WorkflowScope => {
    if (value !== "project" && value !== "global") throw new Error("Choose project or global workflow scope.");
    return value;
  };
  const ownedTask = async (runId: string) => {
    const task = await deps.port.getTask(runId);
    return task?.parentSessionId === deps.sessionId ? task : undefined;
  };
  return {
    retuneWorkflowConcurrency: async (input: { runId: string; maxConcurrency: number | null }) => {
      if (input.maxConcurrency !== null && (!Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency < 1)) {
        throw new Error("Concurrency must be a positive integer or null for the default.");
      }
      const task = await ownedTask(input.runId);
      if (!task) return { ok: false, reason: "not_found" };
      const status = task.runStatus ?? task.status;
      if (status !== "running" && status !== "pending") return { ok: false, reason: "not_live" };
      if (!deps.port.retuneConcurrency) return { ok: false, reason: "unsupported" };
      return await deps.port.retuneConcurrency(input);
    },
    listSavedWorkflows: async () => {
      const results = await Promise.all((["project", "global"] as const).map(async value => {
        const result = await deps.native.list({ workspace, scope: value }) as { workflows?: unknown[]; invalid?: unknown[] };
        return { workflows: result.workflows ?? [], invalid: result.invalid ?? [] };
      }));
      return { workflows: results.flatMap(result => result.workflows), invalid: results.flatMap(result => result.invalid) };
    },
    readSavedWorkflow: async (input: { name: string; scope: WorkflowScope }) => {
      return await deps.native.read({ workspace, name: input.name, scope: scope(input.scope) });
    },
    saveWorkflowRun: async (input: {
      runId: string; name: string; scope: WorkflowScope; description: string; overwrite?: boolean;
    }) => {
      if (!await ownedTask(input.runId)) return { ok: false, reason: "not_found" };
      return await deps.native.save({ deps: { sessionStore: deps.sessionStore } }, {
        workspace, runId: input.runId, name: input.name, scope: scope(input.scope),
        meta: { description: input.description }, overwrite: input.overwrite === true
      });
    }
  };
}
