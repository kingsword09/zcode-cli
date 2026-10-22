export interface SessionLifecycleStore {
  getSession(sessionId: string): Promise<{ time?: { created?: number; updated?: number; deleted?: number } } | null | undefined>;
}

export interface SessionLifecycleRuntime {
  sessionId?: string;
  sessionStore?: SessionLifecycleStore;
  rootTraceContext?: unknown;
  ensureSessionPersistedForExternalActivity?: (title: string, options: { traceContext?: unknown }) => Promise<void>;
}

export async function assertResumableSession(store: SessionLifecycleStore, sessionId: string): Promise<void> {
  const session = await store.getSession(sessionId);
  if (!session || session.time?.deleted !== undefined) throw new Error(`Session not found: ${sessionId}`);
}

export async function ensureSessionForTitle(
  runtime: SessionLifecycleRuntime,
  options: { title: string; traceContext?: unknown }
): Promise<void> {
  if (!runtime.sessionId || !runtime.sessionStore || !runtime.ensureSessionPersistedForExternalActivity) {
    throw new Error("Session persistence is unavailable in this runtime.");
  }
  await runtime.ensureSessionPersistedForExternalActivity(options.title, {
    traceContext: options.traceContext ?? runtime.rootTraceContext
  });
  await assertResumableSession(runtime.sessionStore, runtime.sessionId);
}

export async function readSessionResumeTarget(app: {
  sessionId?: string;
  sessionStore?: SessionLifecycleStore;
  runtime?: SessionLifecycleRuntime;
}): Promise<string | undefined> {
  const sessionId = app.sessionId ?? app.runtime?.sessionId;
  const store = app.sessionStore ?? app.runtime?.sessionStore;
  if (!sessionId || !store) return undefined;
  const session = await store.getSession(sessionId);
  return session && session.time?.deleted === undefined ? sessionId : undefined;
}
