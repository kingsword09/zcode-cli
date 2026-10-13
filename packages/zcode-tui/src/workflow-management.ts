import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { choose, promptText } from "./choice-dialog.ts";
import { modelPicker } from "./selectors.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import { asString, isRecord, type RuntimeAdapter } from "./types.ts";

export interface WorkflowDialogs {
  choose(options: Parameters<typeof choose>[3]): ReturnType<typeof choose>;
  prompt(options: Parameters<typeof promptText>[3]): ReturnType<typeof promptText>;
  notice(message: string, tone: "muted" | "warning" | "error"): void;
  models(): Promise<unknown[]>;
  isCurrent(): boolean;
}

export interface WorkflowSettingsAdjustment {
  max_concurrency?: number | null;
  subagent_model?: string | null;
}

function safe(value: unknown): string {
  return sanitizeTerminalText(asString(value) ?? "", { preserveSgr: false }).slice(0, 2_000);
}

export function workflowAdjustableSettings(toolName: string, input: unknown): Record<string, unknown> | undefined {
  if (toolName !== "CreateWorkflow" && toolName !== "AmendWorkflow") return undefined;
  if (!isRecord(input) || !isRecord(input.adjustable_settings)) return undefined;
  return typeof input.adjustable_settings.subagent_model === "boolean" ? input.adjustable_settings : undefined;
}

export function workflowSettingsSummary(input: Record<string, unknown>, adjustment: WorkflowSettingsAdjustment = {}): string {
  const settings = isRecord(input.adjustable_settings) ? input.adjustable_settings : {};
  const concurrency = adjustment.max_concurrency !== undefined ? adjustment.max_concurrency : input.max_concurrency;
  const model = adjustment.subagent_model !== undefined ? adjustment.subagent_model : input.subagent_model;
  const defaultConcurrency = typeof settings.concurrency_ceiling === "number" ? ` (${settings.concurrency_ceiling})` : "";
  return [
    `Concurrency: ${typeof concurrency === "number" ? concurrency : `default${defaultConcurrency}`}`,
    `Subagent default model: ${safe(model) || "session model"}`,
    ...(isRecord(input.model_bindings) && Object.keys(input.model_bindings).length ? [
      "Models explicitly named in the script remain unchanged.",
      ...Object.entries(input.model_bindings).slice(0, 12).map(([name, reference]) => `${safe(name)} → ${safe(reference)}`)
    ] : [])
  ].join("\n");
}

export async function promptWorkflowConcurrency(dialogs: WorkflowDialogs, signal?: AbortSignal): Promise<number | null | undefined> {
  while (!signal?.aborted && dialogs.isCurrent()) {
    const value = await dialogs.prompt({ title: "Workflow concurrency", prompt: "Enter a positive integer, or default to restore the runtime default.", signal });
    if (value === null || signal?.aborted || !dialogs.isCurrent()) return undefined;
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "default") return null;
    const concurrency = Number(trimmed);
    if (/^[0-9]+$/u.test(trimmed) && Number.isSafeInteger(concurrency) && concurrency > 0) return concurrency;
    dialogs.notice("Enter a positive whole number, or default.", "warning");
  }
  return undefined;
}

export async function requestWorkflowApproval(
  request: Record<string, unknown>, dialogs: WorkflowDialogs, preview?: Component, signal?: AbortSignal
): Promise<unknown> {
  const input = isRecord(request.input) ? request.input : {};
  const settings = workflowAdjustableSettings(String(request.toolName), input);
  const adjustment: WorkflowSettingsAdjustment = {};
  while (!signal?.aborted && dialogs.isCurrent()) {
    const content = new Container();
    content.addChild(new Text(workflowSettingsSummary(input, adjustment), 0, 0));
    if (preview) content.addChild(preview);
    const choice = await dialogs.choose({
      title: `Approve ${safe(request.toolName)}`, prompt: "Review settings before allowing this workflow.", content, signal,
      numberShortcuts: true, filterMode: "substring",
      items: [
        { value: "allow", label: "Allow once", description: "Apply these settings to this workflow only" },
        { value: "deny", label: "Deny" },
        { value: "concurrency", label: "Change concurrency" },
        ...(settings?.subagent_model === true ? [{ value: "model", label: "Change default model" }] : [])
      ]
    });
    if (!choice || choice.value === "deny" || signal?.aborted || !dialogs.isCurrent()) break;
    if (choice.value === "allow") {
      return { decision: "allow", ...(Object.keys(adjustment).length ? { inputAdjustments: adjustment } : {}) };
    }
    if (choice.value === "concurrency") {
      const value = await promptWorkflowConcurrency(dialogs, signal);
      if (value !== undefined) adjustment.max_concurrency = value;
    } else if (choice.value === "model") {
      const models = (await dialogs.models()).filter(model => !isRecord(model) || !model.disabledReason);
      if (signal?.aborted || !dialogs.isCurrent()) break;
      const selected = await dialogs.choose({
        title: "Workflow default model", prompt: "Explicit per-agent models in the script are not overridden.", signal, filterMode: "substring",
        items: [{ value: "default", label: "Session model", payload: null },
          ...modelPicker(models).items.map(item => ({ ...item, payload: item.value }))]
      });
      if (selected && !signal?.aborted && dialogs.isCurrent()) {
        adjustment.subagent_model = typeof selected.payload === "string" ? selected.payload : null;
      }
    }
  }
  return { decision: "deny", reason: "Workflow approval cancelled" };
}

export function workflowActionMessage(result: unknown, success: string): string {
  if (!isRecord(result)) return "Workflow operation returned an invalid result.";
  if (result.ok === true) return `${success}${result.runId ? ` · ${safe(result.runId)}` : ""}${result.path ? ` · ${safe(result.path)}` : ""}${result.shadowing ? ` · ${safe(result.shadowing)}` : ""}`;
  return `Workflow operation rejected: ${safe(result.reason) || "unknown"}${result.message || result.detail ? ` · ${safe(result.message ?? result.detail)}` : ""}`;
}

export async function retuneWorkflow(runId: string, adapter: RuntimeAdapter, dialogs: WorkflowDialogs): Promise<void> {
  const value = await promptWorkflowConcurrency(dialogs);
  if (value === undefined || !dialogs.isCurrent() || !adapter.retuneWorkflowConcurrency) return;
  const confirm = await dialogs.choose({ title: "Apply concurrency", prompt: "Changes only the live run. It will not stop, restart, or replace the workflow.",
    items: [{ value: "apply", label: `Apply ${value === null ? "default concurrency" : `concurrency ${value}`}` }, { value: "cancel", label: "Cancel" }] });
  if (confirm?.value !== "apply" || !dialogs.isCurrent()) return;
  const result = await adapter.retuneWorkflowConcurrency({ runId, maxConcurrency: value });
  if (dialogs.isCurrent()) dialogs.notice(workflowActionMessage(result, "Workflow concurrency updated"), isRecord(result) && result.ok === true ? "muted" : "warning");
}

export async function saveWorkflow(run: Record<string, unknown>, adapter: RuntimeAdapter, dialogs: WorkflowDialogs): Promise<void> {
  if (!adapter.saveWorkflowRun) return;
  const name = await dialogs.prompt({ title: "Save workflow", prompt: "Name: up to 64 letters, digits, dots, underscores or hyphens; no .." });
  if (name === null || !dialogs.isCurrent()) return;
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(trimmed) || trimmed.includes("..")) {
    dialogs.notice("Invalid workflow name. Nothing was saved.", "warning");
    return;
  }
  const scope = await dialogs.choose({ title: "Save workflow scope", prompt: "Choose where this reusable definition is stored.",
    items: [{ value: "project", label: "This project", description: ".zcode/workflows" }, { value: "global", label: "All projects", description: "~/.zcode/workflows" }] });
  if (!scope || !dialogs.isCurrent()) return;
  const description = await dialogs.prompt({ title: "Workflow description", prompt: "Describe what this workflow does.", initialValue: safe(run.label) });
  if (!description?.trim() || !dialogs.isCurrent()) return;
  const input = { runId: String(run.runId), name: trimmed, scope: scope.value as "project" | "global", description: description.trim() };
  let result = await adapter.saveWorkflowRun(input);
  if (!dialogs.isCurrent()) return;
  if (isRecord(result) && result.reason === "target_exists") {
    const confirm = await dialogs.choose({ title: "Replace saved workflow?", prompt: safe(result.path),
      items: [{ value: "cancel", label: "Keep existing definition" }, { value: "overwrite", label: "Replace definition", description: "Overwrite the existing saved script" }] });
    if (confirm?.value !== "overwrite" || !dialogs.isCurrent()) return;
    result = await adapter.saveWorkflowRun({ ...input, overwrite: true });
  }
  if (dialogs.isCurrent()) dialogs.notice(workflowActionMessage(result, "Workflow saved"), isRecord(result) && result.ok === true ? "muted" : "warning");
}

export async function showSavedWorkflows(adapter: RuntimeAdapter, dialogs: WorkflowDialogs): Promise<void> {
  if (!adapter.listSavedWorkflows || !adapter.readSavedWorkflow || !adapter.startSavedWorkflow) {
    dialogs.notice("Saved workflows are unavailable in this runtime.", "warning");
    return;
  }
  const listed = await adapter.listSavedWorkflows();
  if (!dialogs.isCurrent()) return;
  if (!isRecord(listed) || !Array.isArray(listed.workflows)) throw new Error("Saved workflow list is invalid.");
  const workflows = listed.workflows.filter(isRecord).filter(item => typeof item.name === "string" && (item.scope === "project" || item.scope === "global"));
  if (Array.isArray(listed.invalid) && listed.invalid.length) dialogs.notice(`${listed.invalid.length} saved definitions could not be loaded. Fix their source files and retry.`, "warning");
  if (!workflows.length) { dialogs.notice("No saved workflows. Use /workflows to save a run first.", "muted"); return; }
  const choice = await dialogs.choose({ title: "Saved workflows", prompt: "Choose a definition to run again. This starts a new run, not a progress replay.",
    items: workflows.map((item, index) => ({ value: String(index), label: `${safe(item.name)} · ${item.scope}`, description: safe(item.description), payload: item })) });
  if (!choice || !isRecord(choice.payload) || !dialogs.isCurrent()) return;
  const input = { name: String(choice.payload.name), scope: choice.payload.scope as "project" | "global" };
  const definition = await adapter.readSavedWorkflow(input);
  if (!dialogs.isCurrent()) return;
  if (!isRecord(definition) || definition.ok !== true) { dialogs.notice(workflowActionMessage(definition, ""), "warning"); return; }
  const meta = isRecord(definition.meta) ? definition.meta : {};
  const declarations = isRecord(meta.args) ? meta.args : {};
  const parameterHelp = Object.entries(declarations).slice(0, 32).map(([name, declaration]) => {
    const details = isRecord(declaration) ? declaration : {};
    return `${safe(name)}: ${safe(details.type)}${details.required === true ? " (required)" : ""}${details.description ? ` · ${safe(details.description)}` : ""}`;
  }).join("\n");
  let args: Record<string, unknown> | undefined;
  if (Object.keys(declarations).length) {
    while (dialogs.isCurrent()) {
      const text = await dialogs.prompt({ title: "Workflow arguments", prompt: `${parameterHelp}\nEnter a JSON object. {} uses declared defaults.`, initialValue: "{}" });
      if (text === null || !dialogs.isCurrent()) return;
      try {
        const value: unknown = JSON.parse(text);
        if (!isRecord(value)) throw new Error("Arguments must be a JSON object.");
        args = value;
        break;
      } catch { dialogs.notice("Enter a valid JSON object, such as {}.", "warning"); }
    }
  }
  const confirm = await dialogs.choose({ title: "Run saved workflow", prompt: `${safe(input.name)} · ${input.scope}\nStarts a new run and may consume model credits. Runtime validates parameters and models before execution.`,
    items: [{ value: "cancel", label: "Cancel" }, { value: "run", label: "Run workflow" }] });
  if (confirm?.value !== "run" || !dialogs.isCurrent()) return;
  const result = await adapter.startSavedWorkflow({ ...input, ...(args ? { args } : {}) });
  if (dialogs.isCurrent()) dialogs.notice(workflowActionMessage(result, "Saved workflow started"), isRecord(result) && result.ok === true ? "muted" : "warning");
}
