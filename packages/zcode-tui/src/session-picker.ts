import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";

export interface SessionSummary {
  id: string;
  title: string;
  directory: string;
  timeUpdated: number;
  messageCount: number;
  source: "desktop" | "cli";
  pinned: boolean;
  archived: boolean;
}

export interface SessionListOptions {
  limit?: number;
  excludeIds?: ReadonlySet<string>;
  /** Read-only CLI session database (defaults to ~/.zcode/cli/db/db.sqlite). */
  cliDbPath?: string;
  /** Read-only desktop task index (defaults to ~/.zcode/v2/tasks-index.sqlite). */
  tasksDbPath?: string;
  home?: string;
}

interface DesktopTaskInfo {
  title: string;
  pinned: boolean;
  archived: boolean;
}

function defaultCliDbPath(home: string): string {
  return join(home, ".zcode", "cli", "db", "db.sqlite");
}

function defaultTasksDbPath(home: string): string {
  return join(home, ".zcode", "v2", "tasks-index.sqlite");
}

function openReadOnly(path: string): DatabaseSync | undefined {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return undefined;
  }
}

function desktopTaskInfo(tasksDbPath: string): Map<string, DesktopTaskInfo> {
  const result = new Map<string, DesktopTaskInfo>();
  const db = openReadOnly(tasksDbPath);
  if (!db) return result;
  try {
    const rows = db.prepare(
      "SELECT task_id, title, pinned, archived FROM tasks WHERE deleted = 0"
    ).all() as { task_id: string; title: string; pinned: number; archived: number }[];
    for (const row of rows) {
      result.set(row.task_id, {
        title: row.title ?? "",
        pinned: row.pinned === 1,
        archived: row.archived === 1
      });
    }
  } catch {
    // The desktop index is optional; fall back to CLI-only metadata.
  } finally {
    db.close();
  }
  return result;
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}

/**
 * List recent interactive sessions from the shared ZCode session store.
 *
 * The desktop app and the CLI persist sessions in the same SQLite database,
 * so this surfaces desktop conversations as well as CLI ones. Desktop titles
 * and pinned/archived flags come from the desktop's task index when present.
 * All databases are opened read-only and failures degrade gracefully.
 */
export function listRecentSessions(options: SessionListOptions = {}): SessionSummary[] {
  const home = options.home ?? homedir();
  const db = openReadOnly(options.cliDbPath ?? defaultCliDbPath(home));
  if (!db) return [];
  try {
    const rows = db.prepare(
      `SELECT s.id, s.title, s.directory, s.time_updated,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
       FROM session s
       WHERE s.task_type = 'interactive'
         AND s.time_deleted IS NULL
         AND s.id NOT LIKE 'sess_subagent%'
       ORDER BY s.time_updated DESC
       LIMIT ?`
    ).all(options.limit ?? 200) as {
      id: string;
      title: string;
      directory: string;
      time_updated: number;
      message_count: number;
    }[];
    const tasks = desktopTaskInfo(options.tasksDbPath ?? defaultTasksDbPath(home));
    const summaries: SessionSummary[] = [];
    for (const row of rows) {
      if (options.excludeIds?.has(row.id)) continue;
      const task = tasks.get(row.id);
      const inDesktopWorkspace = row.directory.startsWith(join(home, ".zcode", "workspace"));
      summaries.push({
        id: row.id,
        title: firstLine(task?.title || row.title || "(untitled)"),
        directory: row.directory,
        timeUpdated: row.time_updated,
        messageCount: row.message_count,
        source: task !== undefined || inDesktopWorkspace ? "desktop" : "cli",
        pinned: task?.pinned ?? false,
        archived: task?.archived ?? false
      });
    }
    return summaries;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function formatSessionTimestamp(timeUpdated: number): string {
  const date = new Date(timeUpdated);
  if (Number.isNaN(date.getTime())) return "?";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function sessionDetail(session: SessionSummary, currentDirectory?: string): string {
  const lines = [
    session.title,
    "",
    `Session: ${session.id}`,
    `Directory: ${session.directory}`,
    `Updated: ${formatSessionTimestamp(session.timeUpdated)} · ${session.messageCount} messages · ${session.source}${session.pinned ? " · pinned" : ""}${session.archived ? " · archived" : ""}`
  ];
  if (currentDirectory && session.directory !== currentDirectory) {
    lines.push("", "This session belongs to another directory.");
  }
  return lines.join("\n");
}

export function sessionPreview(session: SessionSummary, currentDirectory?: string): Text {
  return new Text(sessionDetail(session, currentDirectory), 1, 0);
}
