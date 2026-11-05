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

export interface SessionListStore {
  listSessions(options: {
    directory?: string;
    limit?: number;
    roots?: boolean;
    taskTypes?: string[];
  }): Promise<Array<{
    id: string;
    title?: string;
    directory?: string;
    parentID?: string | null;
    time?: { created?: number; updated?: number; deleted?: number };
  }>>;
}

interface SessionDatabaseStore {
  getDatabasePath?: () => string;
}

export function readSessionDatabasePath(app: {
  sessionStore?: SessionDatabaseStore;
  runtime?: { sessionStore?: SessionDatabaseStore };
}): string | undefined {
  const store = app.sessionStore ?? app.runtime?.sessionStore;
  return store?.getDatabasePath?.();
}

export interface ResumePickerEntry {
  id: string;
  title: string;
  directory: string;
  updatedAt: number;
  parentId: string | null;
}

/**
 * Back the runtime's native `/resume` picker (which renders only when the app
 * facade exposes `listSessions`). Directory-scoped to match the runtime's own
 * semantics; deleted sessions are excluded by the store itself.
 */
export async function listSessionsForPicker(app: {
  directory?: string;
  sessionStore?: SessionListStore;
  runtime?: { directory?: string; sessionStore?: SessionListStore };
}): Promise<ResumePickerEntry[]> {
  const store = app.sessionStore ?? app.runtime?.sessionStore;
  if (!store?.listSessions) return [];
  const directory = app.directory ?? app.runtime?.directory ?? process.cwd();
  const rows = await store.listSessions({
    directory,
    limit: 50,
    taskTypes: ["interactive", "fork", "workflow_parent"]
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? "",
    directory: row.directory ?? directory,
    updatedAt: row.time?.updated ?? row.time?.created ?? 0,
    parentId: row.parentID ?? null
  }));
}
