import { asString, isRecord } from "./types.ts";
import type { PickerSpec } from "./selectors.ts";
import { truncateGraphemes } from "./terminal-text.ts";

function listRequest(input: string, command: string): boolean {
  const match = /^\/([^\s]+)(?:\s+(.*))?$/u.exec(input.trim());
  if (!match || match[1]?.toLowerCase() !== command) return false;
  const argument = match[2]?.trim().toLowerCase() ?? "";
  return argument === "" || argument === "list" || argument === "status";
}

export function isMcpPickerRequest(input: string): boolean {
  return listRequest(input, "mcp");
}

export function mcpPicker(value: unknown): PickerSpec {
  if (!isRecord(value)) return { items: [], selectedIndex: 0 };
  const items = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, statusValue]) => {
      if (!isRecord(statusValue)) return [];
      const status = asString(statusValue.status) ?? "unknown";
      const transport = asString(statusValue.transport);
      const toolCount = typeof statusValue.toolCount === "number" ? statusValue.toolCount : 0;
      const error = asString(statusValue.error);
      const action = status === "connected" || status === "connecting" ? "disconnect" : "connect";
      return [{
        value: name,
        label: name,
        description: [status, transport, `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`, error]
          .filter((part): part is string => Boolean(part))
          .join(" · "),
        command: `/mcp ${action} ${name}`
      }];
    });
  return { items, selectedIndex: 0 };
}

export function workflowRunPicker(value: unknown): PickerSpec {
  if (!isRecord(value) || !Array.isArray(value.runs)) return { items: [], selectedIndex: 0 };
  const selectedRunId = asString(value.selectedRunId);
  const items = value.runs.flatMap((runValue) => {
    if (!isRecord(runValue)) return [];
    const runId = asString(runValue.runId);
    if (!runId) return [];
    const task = asString(runValue.task) ?? asString(runValue.name) ?? runId;
    const status = asString(runValue.status) ?? "unknown";
    const kind = asString(runValue.kind);
    return [{
      value: runId,
      label: truncateGraphemes(task, 72),
      description: [status, kind, runId === selectedRunId ? "selected" : runId]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
      command: runId
    }];
  });
  const selectedIndex = items.findIndex((item) => item.value === selectedRunId);
  return { items, selectedIndex: selectedIndex >= 0 ? selectedIndex : 0 };
}

export function workflowSelectedRunId(value: unknown): string | undefined {
  return isRecord(value) ? asString(value.selectedRunId) : undefined;
}

export function workflowStatus(value: unknown, runId: string): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.runs)) return undefined;
  const run = value.runs.find((entry) => isRecord(entry) && asString(entry.runId) === runId);
  return isRecord(run) ? asString(run.status) : undefined;
}

export function isTerminalWorkflowStatus(status?: string): boolean {
  return status !== undefined && new Set([
    "cancelled",
    "completed",
    "error",
    "failed",
    "stopped",
    "succeeded"
  ]).has(status.toLowerCase());
}

function eventList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["events", "items", "entries"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function eventLine(value: unknown): string | undefined {
  if (!isRecord(value)) return asString(value);
  const type = asString(value.type) ?? asString(value.event) ?? asString(value.kind);
  const status = asString(value.status);
  const message = asString(value.message) ?? asString(value.text) ?? asString(value.phase);
  const time = asString(value.timestamp) ?? asString(value.createdAt);
  const shortTime = time?.match(/T(\d\d:\d\d:\d\d)/u)?.[1] ?? time;
  const parts = [shortTime, type, status, message].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function schedulerLine(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const fields = ["status", "phase", "active", "running", "completed", "failed", "total"];
  const parts = fields.flatMap((key) => {
    const field = value[key];
    return typeof field === "string" || typeof field === "number" || typeof field === "boolean"
      ? [`${key}: ${String(field)}`]
      : [];
  });
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatWorkflowPanel(value: unknown): string {
  if (!isRecord(value)) return "### Workflows\n\nWorkflow details are unavailable.";
  const title = asString(value.title) ?? "Workflows";
  const selectedRunId = asString(value.selectedRunId);
  const runs = Array.isArray(value.runs) ? value.runs.filter(isRecord) : [];
  const selected = runs.find((run) => asString(run.runId) === selectedRunId) ?? runs[0];
  if (!selected) return `### ${title}\n\nNo workflow runs found.`;

  const detail = isRecord(value.detail) ? value.detail : undefined;
  const snapshot = isRecord(detail?.snapshot) ? detail.snapshot : selected;
  const runId = asString(snapshot.runId) ?? asString(selected.runId) ?? "unknown";
  const task = asString(snapshot.task) ?? asString(selected.task) ?? "Untitled workflow";
  const status = asString(snapshot.status) ?? asString(selected.status) ?? "unknown";
  const kind = asString(snapshot.kind) ?? asString(selected.kind);
  const updatedAt = asString(snapshot.updatedAt) ?? asString(selected.updatedAt) ?? asString(value.updatedAt);
  const lines = [
    `### ${title}`,
    "",
    `**${task}**`,
    `- Status: ${status}`,
    `- Run: ${runId}`
  ];
  if (kind) lines.push(`- Kind: ${kind}`);
  if (updatedAt) lines.push(`- Updated: ${updatedAt}`);
  const scheduler = schedulerLine(detail?.scheduler);
  if (scheduler) lines.push(`- Scheduler: ${scheduler}`);

  const events = eventList(detail?.events).map(eventLine).filter((line): line is string => Boolean(line));
  if (events.length > 0) {
    lines.push("", "Recent events:", ...events.slice(-8).map((line) => `- ${line}`));
  }
  if (runs.length > 1) lines.push("", `${runs.length} workflow runs available.`);
  return lines.join("\n");
}
