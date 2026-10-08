/** Runs complete permission interactions in FIFO order so their dialogs never overlap. */
export class PermissionRequestQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(request: () => Promise<T>): Promise<T> {
    const result = this.tail.then(request);
    // A failed request must not poison the queue or block later permissions.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/**
 * The abort signal of one permission request. The runtime passes its broker
 * options (`{ signal, claimResponse, timeoutMs }`) as the request context and
 * aborts `signal` when another responder settles the request first, such as a
 * `PermissionRequest` hook that allows or denies the call. `abortSignal` is
 * accepted as well for callers that use the TUI's own option name.
 */
export function permissionRequestSignal(context: unknown): AbortSignal | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  const record = context as { signal?: unknown; abortSignal?: unknown };
  if (record.signal instanceof AbortSignal) return record.signal;
  if (record.abortSignal instanceof AbortSignal) return record.abortSignal;
  return undefined;
}
