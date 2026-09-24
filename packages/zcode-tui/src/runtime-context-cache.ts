import { contextCacheUsage, type RuntimeContextUsage } from "./runtime-projection.ts";

type CacheUsage = RuntimeContextUsage["cache"];

/** A session-scoped, invalidatable summary of persisted request usage. */
export class RuntimeContextCache {
  private sessionId?: string;
  private revision = 0;
  private loadedRevision = -1;
  private usage?: CacheUsage;
  private pending?: { revision: number; promise: Promise<CacheUsage> };

  invalidate(): void {
    this.revision++;
  }

  reset(): void {
    this.invalidate();
    this.usage = undefined;
    this.loadedRevision = -1;
    this.pending = undefined;
  }

  async read(sessionId: string | undefined, loadMessages: () => Promise<unknown>): Promise<CacheUsage> {
    if (sessionId !== this.sessionId) {
      this.reset();
      this.sessionId = sessionId;
    }
    if (this.loadedRevision === this.revision) return this.usage;
    if (this.pending?.revision === this.revision) return this.pending.promise;
    const revision = this.revision;
    const promise = Promise.resolve().then(loadMessages).then((messages) => {
      // A completed read from the previous session/revision must never replace
      // newer usage, including when /resume changes the app during this query.
      if (revision !== this.revision) return undefined;
      this.usage = contextCacheUsage(messages);
      this.loadedRevision = revision;
      return this.usage;
    }).finally(() => {
      if (this.pending?.revision === revision) this.pending = undefined;
    });
    this.pending = { revision, promise };
    return promise;
  }
}
