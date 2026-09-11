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
