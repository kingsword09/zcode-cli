import type { ProtectedSubmission } from "./selection-command.ts";
import type { StreamEvent } from "./events.ts";

export interface QueuedSubmission extends ProtectedSubmission {
  externalLogin?: boolean;
}

export interface PendingSteerSubmission {
  inputId: string;
  pendingInputId?: string;
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

export class InputQueue {
  private readonly pendingSteers: PendingSteerSubmission[] = [];
  private readonly queuedFollowUps: QueuedSubmission[] = [];
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

  trackSteer(submission: QueuedSubmission, inputId: string): PendingSteerSubmission {
    const pending: PendingSteerSubmission = { inputId, submission };
    this.pendingSteers.push(pending);
    this.syncView();
    return pending;
  }

  findSteer(inputId: string | undefined): PendingSteerSubmission | undefined {
    return inputId ? this.pendingSteers.find((pending) => pending.inputId === inputId) : undefined;
  }

  associateSteer(inputId: string, pendingInputId: string): void {
    const pending = this.pendingSteers.find((candidate) => (
      candidate.inputId === inputId || candidate.pendingInputId === pendingInputId
    ));
    if (!pending || pending.pendingInputId === pendingInputId) return;
    pending.pendingInputId = pendingInputId;
    this.syncView();
  }

  removeSteer(inputId: string | undefined): PendingSteerSubmission | undefined {
    if (!inputId) return undefined;
    const index = this.pendingSteers.findIndex((pending) => pending.inputId === inputId);
    if (index < 0) return undefined;
    const [pending] = this.pendingSteers.splice(index, 1);
    this.syncView();
    return pending;
  }

  private takeSteer(pendingInputId: string): PendingSteerSubmission | undefined {
    const index = this.pendingSteers.findIndex((pending) => pending.pendingInputId === pendingInputId);
    if (index < 0) return undefined;
    const [pending] = this.pendingSteers.splice(index, 1);
    return pending;
  }

  handleLifecycleEvent(event: StreamEvent): boolean {
    if (event.type === "turn_steer_queued" || event.type === "turn.steerQueued") {
      if (event.inputId && event.pendingInputId) {
        this.associateSteer(event.inputId, event.pendingInputId);
      }
      return true;
    }
    if (event.type === "turn_steer_drained" || event.type === "turn.steerDrained") {
      this.commitSteers(event.pendingInputIds ?? [], event.injectedMessageIds ?? []);
      return true;
    }
    if (event.type === "turn_steer_discarded" || event.type === "turn.steerDiscarded") {
      this.discardSteers(event.pendingInputIds ?? [], event.reason);
      return true;
    }
    return false;
  }

  private commitSteers(pendingInputIds: string[], messageIds: string[]): void {
    const committed = pendingInputIds.flatMap((pendingInputId, index) => {
      const pending = this.takeSteer(pendingInputId);
      return pending ? [{ messageId: messageIds[index], displayInput: pending.submission.displayInput }] : [];
    });
    if (committed.length === 0) return;
    this.callbacks.onSteerCommitted(committed);
    this.syncView();
  }

  private discardSteers(pendingInputIds: string[], reason?: string): void {
    const discarded = pendingInputIds.flatMap((pendingInputId) => {
      const pending = this.takeSteer(pendingInputId);
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

  private syncView(): void {
    this.callbacks.onStateChanged({
      pendingSteers: this.pendingSteers.map(({ submission }) => submission.displayInput),
      queuedInputs: this.queuedFollowUps.map((submission) => submission.displayInput)
    });
  }
}
