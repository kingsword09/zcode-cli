import type { StreamEvent } from "./events.ts";
import {
  isActiveRuntimeTool,
  type RuntimeProjectionSnapshot
} from "./runtime-projection.ts";

const terminalStatuses = new Set([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_error",
  "lost",
  "stopped"
]);

function eventTaskId(event: StreamEvent): string | undefined {
  return event.taskId ?? event.agentId ?? event.progress?.agentId;
}

function startsTask(event: StreamEvent): boolean {
  return event.type === "background_task_started"
    || event.type === "subagent_spawned"
    || (event.type === "background_task_updated" && !terminalStatuses.has(event.taskStatus ?? "running"));
}

function settlesTask(event: StreamEvent): boolean {
  return event.type === "background_task_completed"
    || event.type === "subagent_stopped"
    || terminalStatuses.has(event.taskStatus ?? "");
}

export class TurnWorkTracker {
  private foregroundActive = false;
  private awaitingProjection = false;
  private projectionToolActive = false;
  private projectionTurnActive = false;
  private turnId?: string;
  private readonly taskIds = new Set<string>();

  begin(): void {
    this.foregroundActive = true;
    this.awaitingProjection = false;
    this.projectionToolActive = false;
    this.projectionTurnActive = false;
    this.turnId = undefined;
    this.taskIds.clear();
  }

  bindTurn(turnId: string | undefined): void {
    if (turnId) this.turnId = turnId;
  }

  handle(event: StreamEvent): boolean {
    const taskId = eventTaskId(event);
    if (!taskId) return this.isActive();
    if (settlesTask(event)) {
      this.taskIds.delete(taskId);
      return this.isActive();
    }
    if (startsTask(event) && this.accepts(event.turnId)) this.taskIds.add(taskId);
    return this.isActive();
  }

  finishForeground(awaitProjection: boolean): boolean {
    this.foregroundActive = false;
    this.awaitingProjection = awaitProjection;
    return this.isActive();
  }

  reconcile(projection: RuntimeProjectionSnapshot): boolean {
    const jobs = projection.backgroundJobs;
    for (const job of jobs) {
      const related = this.taskIds.has(job.taskId)
        || Boolean(this.turnId && job.turnId === this.turnId);
      if (!related) continue;
      if (job.status === "running") this.taskIds.add(job.taskId);
      else this.taskIds.delete(job.taskId);
    }
    this.projectionTurnActive = Boolean(
      projection.currentTurnId && projection.currentTurnId === this.turnId
    );
    this.projectionToolActive = projection.activeToolCalls.some(isActiveRuntimeTool);
    if (!this.foregroundActive) this.awaitingProjection = false;
    return this.isActive();
  }

  isActive(): boolean {
    return this.foregroundActive
      || this.awaitingProjection
      || this.projectionToolActive
      || this.projectionTurnActive
      || this.taskIds.size > 0;
  }

  ownsTask(taskId: string | undefined): boolean {
    return Boolean(taskId && this.taskIds.has(taskId));
  }

  private accepts(turnId: string | undefined): boolean {
    if (turnId && this.turnId) return turnId === this.turnId;
    return this.foregroundActive || this.awaitingProjection;
  }
}
