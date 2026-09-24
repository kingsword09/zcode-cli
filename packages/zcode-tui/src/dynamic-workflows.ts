import { asString, isRecord, type RuntimeAdapter, type UnknownRecord } from "./types.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";

const maximumRuns = 20;
const maximumBufferedEvents = 2_000;

export class DynamicWorkflows {
  private state: unknown;
  private summaries: UnknownRecord[] = [];
  private epoch = 0;
  private loading?: Promise<void>;
  private buffered: UnknownRecord[] = [];
  private watermarks = new Map<string, number>();
  private lastEvents = new Map<string, string>();
  private incomplete = false;
  error?: string;

  constructor(private readonly adapter: Pick<RuntimeAdapter, "listWorkflowRuns" | "replayWorkflowRuns" | "reduceWorkflowRuns">) {}

  reset(): void {
    this.epoch++;
    this.state = undefined;
    this.summaries = [];
    this.loading = undefined;
    this.buffered = [];
    this.watermarks.clear();
    this.lastEvents.clear();
    this.error = undefined;
    this.incomplete = false;
  }

  runs(): UnknownRecord[] {
    const runs = isRecord(this.state) && Array.isArray(this.state.runs) ? this.state.runs.filter(isRecord) : [];
    const byId = new Map(runs.map((run) => [run.runId, run]));
    const summaries = this.summaries.map((summary) => {
      const run = byId.get(summary.runId);
      byId.delete(summary.runId);
      return run ? { ...run, label: summary.label, updatedAt: summary.updatedAt } : summary;
    });
    return [...summaries, ...byId.values()].slice(0, maximumRuns)
      .map((run) => this.incomplete ? { ...run, progressIncomplete: true } : run);
  }

  accept(event: unknown): boolean {
    if (!isRecord(event) || typeof event.runId !== "string" || typeof event.eventType !== "string") return false;
    if (this.loading) {
      if (this.buffered.length < maximumBufferedEvents) this.buffered.push(event);
      else {
        this.incomplete = true;
        this.error = "Some workflow progress was omitted. Live runs cannot be fully replayed in this process; use /dwf list for runtime status.";
      }
      return false;
    }
    return this.apply(event);
  }

  private apply(event: UnknownRecord): boolean {
    if (!this.adapter.reduceWorkflowRuns) return false;
    const id = String(event.runId);
    const sequence = typeof event.sequence === "number" ? event.sequence : undefined;
    const watermark = this.watermarks.get(id) ?? -1;
    const fingerprint = JSON.stringify(event);
    if (sequence !== undefined && (sequence < watermark
      || sequence === watermark && this.lastEvents.get(id) === fingerprint)) return false;
    try {
      const state = this.adapter.reduceWorkflowRuns(this.state, event);
      if (sequence !== undefined) this.watermarks.set(id, sequence);
      this.lastEvents.set(id, fingerprint);
      if (!state) return false;
      this.state = state;
      // The runtime bounds its retained runs; mirror its retention for cursors.
      if (isRecord(state) && Array.isArray(state.runs)) {
        const ids = new Set(state.runs.filter(isRecord).map((run) => String(run.runId)));
        for (const key of this.watermarks.keys()) if (!ids.has(key)) {
          this.watermarks.delete(key);
          this.lastEvents.delete(key);
        }
      }
      return true;
    } catch (error) {
      this.error = `Workflow progress could not be read: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  hydrate(): Promise<void> {
    if (this.loading) return this.loading;
    const epoch = this.epoch;
    if (!this.incomplete) this.error = undefined;
    const operation = Promise.resolve().then(async () => {
      // Read replay before summaries. Live events are buffered until replay is
      // applied, then sequence watermarks discard duplicate deliveries.
      const results = await Promise.allSettled([
        this.adapter.replayWorkflowRuns?.({ excludeRunIds: new Set<string>() }),
        this.adapter.listWorkflowRuns?.()
      ]);
      if (epoch !== this.epoch) return;
      const [replay, summaries] = results;
      if (replay.status === "fulfilled" && Array.isArray(replay.value)) {
        for (const event of replay.value) if (isRecord(event)) this.apply(event);
      }
      if (summaries.status === "fulfilled" && Array.isArray(summaries.value)) {
        this.summaries = summaries.value.filter((value) => isRecord(value) && typeof value.runId === "string").slice(0, maximumRuns);
      }
      for (const result of results) if (result.status === "rejected") {
        this.error = `Workflow history could not be loaded: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}. Run /workflows to retry.`;
      }
    }).finally(() => {
      if (epoch !== this.epoch) return;
      this.loading = undefined;
      for (const event of this.buffered) this.apply(event);
      this.buffered = [];
    });
    this.loading = operation;
    return operation;
  }
}

function safe(value: unknown): string {
  return sanitizeTerminalText(typeof value === "string" ? value : "", { preserveSgr: false }).slice(0, 2_000);
}

export function workflowRunDetail(run: UnknownRecord): string {
  const nodes = Array.isArray(run.nodes) ? run.nodes.filter(isRecord) : undefined;
  const actors = Array.isArray(run.actors) ? run.actors.filter(isRecord) : [];
  const artifacts = Array.isArray(run.artifacts) ? run.artifacts.filter(isRecord) : [];
  const usage = isRecord(run.usage) ? run.usage : undefined;
  const lines = [safe(run.label) || safe(run.runId), `Status: ${safe(run.status) || "unknown"}${run.stopReason ? ` · ${safe(run.stopReason)}` : ""}`];
  if (run.progressIncomplete === true) lines.push("Progress is incomplete. Use /dwf list for runtime status.");
  if (nodes) lines.push(`Steps: ${nodes.filter((node) => node.phase === "settled").length}/${nodes.length} observed steps settled`);
  if (typeof usage?.spentTokens === "number") lines.push(`Tokens: ${usage.spentTokens.toLocaleString()}`);
  if (run.resumable === true) lines.push("This run can be resumed.");
  if (actors.length) lines.push("", "Agents", ...actors.slice(0, 12).map((actor) => `${safe(actor.name) || safe(actor.sessionId) || "Agent"} · ${safe(actor.status)}`));
  if (artifacts.length) lines.push("", "Artifacts", ...artifacts.slice(0, 12).map((artifact) => safe(artifact.title) || safe(artifact.artifactId) || safe(artifact.id)));
  if (asString(run.error)) lines.push("", `Error: ${safe(run.error)}`);
  if (asString(run.resultPreview)) lines.push("", safe(run.resultPreview));
  return lines.join("\n");
}
