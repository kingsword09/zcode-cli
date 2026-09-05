import type { InputQueue, QueuedSubmission } from "./input-queue.ts";

/** Preserve rejected input without replacing a draft typed during validation. */
export async function preflightSubmission(options: {
  validate(): Promise<string | undefined>;
  isStopped(): boolean;
  submission: QueuedSubmission;
  queued: boolean;
  editor: { getText(): string; setText(text: string): void };
  inputQueue: InputQueue;
  warn(message: string): void;
}): Promise<boolean> {
  const diagnostic = await options.validate();
  if (options.isStopped()) return false;
  if (!diagnostic) return true;

  if (options.queued || options.editor.getText() !== "") {
    options.inputQueue.restoreFollowUp(options.submission);
  } else {
    options.editor.setText(options.submission.input);
    options.inputQueue.autoSend = false;
  }
  options.warn(diagnostic);
  return false;
}
