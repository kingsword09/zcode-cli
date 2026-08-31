import type { ProtectedSubmission } from "./selection-command.ts";
import type { StreamEvent } from "./events.ts";

export interface QueuedSubmission extends ProtectedSubmission {
  externalLogin?: boolean;
  pendingInputReservationId?: string;
  pendingInputIds?: string[];
  /** System-initiated submissions (task-center coordinator notices) never ping. */
  suppressCompletionNotification?: boolean;
}

export interface PendingSteerSubmission {
  admitted: boolean;
  inputId: string;
  pendingInputId?: string;
  targetTurnId?: string;
  submission: QueuedSubmission;
}

export interface InputQueueState {
  pendingSteers: string[];
  queuedInputs: string[];
}

export interface CommittedSteer {
  displayInput: string;
  messageId?: string;
}

export interface InputQueueCallbacks {
  onStateChanged(state: InputQueueState): void;
  onSteerCommitted(entries: CommittedSteer[]): void;
  onSteerDiscarded(count: number, reason?: string): void;
}

interface PendingSteerResolution {
  kind: "committed" | "discarded";
  messageId?: string;
  reason?: string;
  targetTurnId?: string;
}

export class InputQueue {
  private readonly pendingSteers: PendingSteerSubmission[] = [];
  private readonly queuedFollowUps: QueuedSubmission[] = [];
  private readonly pendingResolutions = new Map<string, PendingSteerResolution>();
  private readonly completedTurnIds = new Set<string>();
  private autoSendEnabled = true;

  constructor(private readonly callbacks: InputQueueCallbacks) {}

  // --- Follow-up queue ---

  queueFollowUp(submission: QueuedSubmission): void {
    this.queuedFollowUps.push(submission);
    this.syncView();
  }

  takeNextFollowUp(): QueuedSubmission | undefined {
    const submission = this.queuedFollowUps.shift();
    if (submission) this.syncView();
    return submission;
  }

  editLatestFollowUp(): QueuedSubmission | undefined {
    const submission = this.queuedFollowUps.pop();
    if (submission) this.syncView();
    return submission;
  }

  hasFollowUps(): boolean {
    return this.queuedFollowUps.length > 0;
  }

  hasPendingSteers(): boolean {
    return this.pendingSteers.length > 0;
  }

  admittedPendingInputIds(): string[] {
    return this.pendingSteers.flatMap(({ admitted, pendingInputId }) => (
      admitted && pendingInputId ? [pendingInputId] : []
    ));
  }

  // --- Auto-send flag ---

  get autoSend(): boolean {
    return this.autoSendEnabled;
  }

  set autoSend(value: boolean) {
    this.autoSendEnabled = value;
  }

  resetAutoSend(): void {
    this.autoSendEnabled = true;
  }

  // --- Steer lifecycle ---

  trackSteer(
    submission: QueuedSubmission,
    inputId: string,
    targetTurnId?: string,
    pendingInputId?: string
  ): PendingSteerSubmission {
    const pending: PendingSteerSubmission = {
      admitted: false,
      inputId,
      pendingInputId,
      submission,
      targetTurnId
    };
    this.pendingSteers.push(pending);
    this.syncView();
    return pending;
  }

  findSteer(inputId: string | undefined): PendingSteerSubmission | undefined {
    return inputId ? this.pendingSteers.find((pending) => pending.inputId === inputId) : undefined;
  }

  associateSteer(inputId: string, pendingInputId: string, targetTurnId?: string): void {
    const pending = this.pendingSteers.find((candidate) => (
      candidate.inputId === inputId || candidate.pendingInputId === pendingInputId
    ));
    if (!pending || !this.matchesTurn(pending.targetTurnId, targetTurnId)) return;
    pending.admitted = true;
    pending.pendingInputId = pendingInputId;
    pending.targetTurnId ??= targetTurnId;
    const resolution = this.pendingResolutions.get(pendingInputId);
    if (resolution && this.matchesTurn(pending.targetTurnId, resolution.targetTurnId)) {
      this.pendingResolutions.delete(pendingInputId);
      this.settleSteer(pending, resolution);
      return;
    }
    this.syncView();
  }

  removeSteer(inputId: string | undefined): PendingSteerSubmission | undefined {
    if (!inputId) return undefined;
    const index = this.pendingSteers.findIndex((pending) => pending.inputId === inputId);
    if (index < 0) return undefined;
    const [pending] = this.pendingSteers.splice(index, 1);
    if (pending?.pendingInputId) this.pendingResolutions.delete(pending.pendingInputId);
    else if (!this.pendingSteers.some((candidate) => !candidate.pendingInputId)) this.pendingResolutions.clear();
    this.syncView();
    return pending;
  }

  requeuePendingSteers(
    reason = "turn_ended",
    targetTurnId?: string,
    mergeForImmediateSubmission = false,
    pendingInputReservationId?: string
  ): number {
    if (targetTurnId) this.rememberCompletedTurn(targetTurnId);
    const discarded = this.pendingSteers.splice(0);
    for (const pending of discarded) {
      if (pending.targetTurnId) this.rememberCompletedTurn(pending.targetTurnId);
      if (pending.pendingInputId) this.pendingResolutions.delete(pending.pendingInputId);
    }
    this.pendingResolutions.clear();
    if (discarded.length === 0) return 0;
    if (mergeForImmediateSubmission) {
      const [first] = discarded;
      const pendingInputIds = discarded.flatMap(({ admitted, pendingInputId }) => (
        admitted && pendingInputId ? [pendingInputId] : []
      ));
      this.queuedFollowUps.unshift({
        ...first!.submission,
        displayInput: discarded.map(({ submission }) => submission.displayInput).join("\n"),
        input: discarded.map(({ submission }) => submission.input).join("\n"),
        ...(pendingInputIds.length > 0 && pendingInputReservationId
          ? { pendingInputReservationId }
          : {}),
        ...(pendingInputIds.length > 0 ? { pendingInputIds } : {}),
        recordHistory: false,
        secrets: discarded.flatMap(({ submission }) => submission.secrets)
      });
    } else {
      this.queuedFollowUps.push(...discarded.map(({ admitted, pendingInputId, submission }) => ({
        ...submission,
        ...(admitted && pendingInputId ? { pendingInputIds: [pendingInputId] } : {}),
        recordHistory: false
      })));
    }
    this.syncView();
    if (!mergeForImmediateSubmission) {
      this.callbacks.onSteerDiscarded(discarded.length, reason);
    }
    return discarded.length;
  }

  private takeSteer(
    pendingInputId: string,
    targetTurnId?: string
  ): PendingSteerSubmission | undefined {
    const index = this.pendingSteers.findIndex((pending) => (
      pending.pendingInputId === pendingInputId
      && this.matchesTurn(pending.targetTurnId, targetTurnId)
    ));
    if (index < 0) return undefined;
    const [pending] = this.pendingSteers.splice(index, 1);
    return pending;
  }

  handleLifecycleEvent(event: StreamEvent): boolean {
    const queued = event.type === "turn_steer_queued" || event.type === "turn.steerQueued";
    const drained = event.type === "turn_steer_drained" || event.type === "turn.steerDrained";
    const discarded = event.type === "turn_steer_discarded" || event.type === "turn.steerDiscarded";
    if (!queued && !drained && !discarded) return false;
    if (event.targetTurnId && this.completedTurnIds.has(event.targetTurnId)) return true;
    if (queued) {
      if (event.inputId && event.pendingInputId) {
        this.associateSteer(event.inputId, event.pendingInputId, event.targetTurnId);
      }
      return true;
    }
    if (drained) {
      this.commitSteers(
        event.pendingInputIds ?? [],
        event.injectedMessageIds ?? [],
        event.targetTurnId
      );
      return true;
    }
    this.discardSteers(event.pendingInputIds ?? [], event.reason, event.targetTurnId);
    return true;
  }

  private commitSteers(
    pendingInputIds: string[],
    messageIds: string[],
    targetTurnId?: string
  ): void {
    const committed = pendingInputIds.flatMap((pendingInputId, index) => {
      const pending = this.takeSteer(pendingInputId, targetTurnId);
      if (pending) return [{ messageId: messageIds[index], displayInput: pending.submission.displayInput }];
      this.rememberResolution(pendingInputId, {
        kind: "committed",
        messageId: messageIds[index],
        targetTurnId
      });
      return [];
    });
    if (committed.length === 0) return;
    this.callbacks.onSteerCommitted(committed);
    this.syncView();
  }

  private discardSteers(
    pendingInputIds: string[],
    reason?: string,
    targetTurnId?: string
  ): void {
    const discarded = pendingInputIds.flatMap((pendingInputId) => {
      const pending = this.takeSteer(pendingInputId, targetTurnId);
      if (!pending) {
        this.rememberResolution(pendingInputId, { kind: "discarded", reason, targetTurnId });
      }
      return pending ? [pending] : [];
    });
    if (discarded.length === 0) return;
    this.queuedFollowUps.push(...discarded.map(({ submission }) => ({
      ...submission,
      recordHistory: false
    })));
    this.syncView();
    this.callbacks.onSteerDiscarded(discarded.length, reason);
  }

  private settleSteer(pending: PendingSteerSubmission, resolution: PendingSteerResolution): void {
    const index = this.pendingSteers.indexOf(pending);
    if (index < 0) return;
    this.pendingSteers.splice(index, 1);
    if (resolution.kind === "committed") {
      this.callbacks.onSteerCommitted([{
        messageId: resolution.messageId,
        displayInput: pending.submission.displayInput
      }]);
    } else {
      this.queuedFollowUps.push({ ...pending.submission, recordHistory: false });
      this.callbacks.onSteerDiscarded(1, resolution.reason);
    }
    this.syncView();
  }

  private rememberResolution(pendingInputId: string, resolution: PendingSteerResolution): void {
    if (!this.pendingSteers.some((pending) => (
      !pending.pendingInputId && this.matchesTurn(pending.targetTurnId, resolution.targetTurnId)
    ))) return;
    this.pendingResolutions.set(pendingInputId, resolution);
  }

  private matchesTurn(left?: string, right?: string): boolean {
    return left === undefined || right === undefined || left === right;
  }

  private rememberCompletedTurn(turnId: string): void {
    this.completedTurnIds.add(turnId);
    if (this.completedTurnIds.size > 32) {
      const oldest = this.completedTurnIds.values().next().value;
      if (oldest) this.completedTurnIds.delete(oldest);
    }
  }

  private syncView(): void {
    this.callbacks.onStateChanged({
      pendingSteers: this.pendingSteers.map(({ submission }) => submission.displayInput),
      queuedInputs: this.queuedFollowUps.map((submission) => submission.displayInput)
    });
  }
}
