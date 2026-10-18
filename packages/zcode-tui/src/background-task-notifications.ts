export interface RestoredNotificationMessage {
  role?: string;
  parts?: ReadonlyArray<{ type?: string; text?: string }>;
}

const deliveredTaskIdPattern = /<task-id>([^<]{1,200})<\/task-id>/gu;

/** Task ids whose terminal notification already exists in the conversation. */
export function deliveredBackgroundTaskIds(
  messages: ReadonlyArray<RestoredNotificationMessage>
): Set<string> {
  const delivered = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts ?? []) {
      if (typeof part.text !== "string") continue;
      for (const match of part.text.matchAll(deliveredTaskIdPattern)) {
        const taskId = match[1]?.trim();
        if (taskId) delivered.add(taskId);
      }
    }
  }
  return delivered;
}
