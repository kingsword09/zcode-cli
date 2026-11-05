import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { choose } from "../packages/zcode-tui/src/choice-dialog.ts";
import { listRecentSessions, formatSessionTimestamp, sessionChoiceItem, sessionPreview, type SessionSummary } from "../packages/zcode-tui/src/session-picker.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import { readSessionDatabasePath } from "../src/runtime-session-lifecycle.ts";

let home: string;
let cliDbPath: string;
let tasksDbPath: string;

function createCliDb(path = cliDbPath): Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session (
      id text primary key,
      directory text not null,
      title text not null,
      task_type text not null default 'interactive',
      time_created integer not null,
      time_updated integer not null,
      time_deleted integer
    );
    CREATE TABLE message (
      id text primary key,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    );
  `);
  return db;
}

function insertSession(
  db: Database,
  fields: {
    id: string;
    title?: string;
    directory?: string;
    taskType?: string;
    timeUpdated?: number;
    timeDeleted?: number;
    messages?: number;
  }
): void {
  const time = fields.timeUpdated ?? 1_700_000_000_000;
  db.prepare(
    `INSERT INTO session (id, directory, title, task_type, time_created, time_updated, time_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fields.id,
    fields.directory ?? "/tmp/project",
    fields.title ?? "",
    fields.taskType ?? "interactive",
    time,
    time,
    fields.timeDeleted ?? null
  );
  for (let index = 0; index < (fields.messages ?? 0); index += 1) {
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, '{}')"
    ).run(`msg_${fields.id}_${index}`, fields.id, time, time);
  }
}

function createTasksDb(): Database {
  const db = new Database(tasksDbPath);
  db.exec(`
    CREATE TABLE tasks (
      workspace_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_key, task_id)
    );
  `);
  return db;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "zs-session-picker-"));
  cliDbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
  tasksDbPath = join(home, ".zcode", "v2", "tasks-index.sqlite");
  mkdirSync(join(cliDbPath, ".."), { recursive: true });
  mkdirSync(join(tasksDbPath, ".."), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("listRecentSessions", () => {
  test("returns no sessions when the CLI database is missing", () => {
    expect(listRecentSessions({ home, cliDbPath: join(home, "missing.sqlite") })).toEqual([]);
  });

  test("lists interactive sessions newest first with message counts", () => {
    const db = createCliDb();
    insertSession(db, { id: "sess_old", title: "old one", timeUpdated: 1_700_000_000_000, messages: 2 });
    insertSession(db, { id: "sess_new", title: "new one", timeUpdated: 1_700_000_100_000, messages: 5 });
    db.close();
    const sessions = listRecentSessions({ home, cliDbPath, tasksDbPath });
    expect(sessions.map((session) => session.id)).toEqual(["sess_new", "sess_old"]);
    expect(sessions[0]?.messageCount).toBe(5);
    expect(sessions[0]?.title).toBe("new one");
    expect(sessions[0]?.source).toBe("cli");
  });

  test("skips subagent sessions, non-resumable tasks and deleted sessions", () => {
    const db = createCliDb();
    insertSession(db, { id: "sess_subagent_agent_123", title: "agent" });
    insertSession(db, { id: "sess_task", title: "task", taskType: "scheduled" });
    insertSession(db, { id: "sess_child", taskType: "subagent_child" });
    insertSession(db, { id: "sess_workflow_child", taskType: "workflow_child" });
    insertSession(db, { id: "sess_deleted", title: "deleted", timeDeleted: 1_700_000_200_000 });
    insertSession(db, { id: "sess_keep", title: "keep" });
    db.close();
    const sessions = listRecentSessions({ home, cliDbPath, tasksDbPath });
    expect(sessions.map((session) => session.id)).toEqual(["sess_keep"]);
  });

  test("includes forks and workflow parents across directories", () => {
    const db = createCliDb();
    insertSession(db, { id: "sess_interactive", directory: "/tmp/project-a", timeUpdated: 1_000 });
    insertSession(db, { id: "sess_fork", taskType: "fork", directory: "/tmp/project-b", timeUpdated: 2_000 });
    insertSession(db, { id: "sess_workflow", taskType: "workflow_parent", directory: "/tmp/project-c", timeUpdated: 3_000 });
    db.close();
    const sessions = listRecentSessions({ home, cliDbPath, tasksDbPath });
    expect(sessions.map((session) => session.id)).toEqual(["sess_workflow", "sess_fork", "sess_interactive"]);
    expect(sessions.map((session) => session.directory)).toEqual(["/tmp/project-c", "/tmp/project-b", "/tmp/project-a"]);
  });

  test("reads the active runtime database instead of the default store", () => {
    const db = createCliDb();
    insertSession(db, { id: "sess_default" });
    db.close();
    const customPath = join(home, "custom.sqlite");
    const custom = createCliDb(customPath);
    insertSession(custom, { id: "sess_custom" });
    custom.close();
    const app = { sessionStore: { getDatabasePath: () => customPath } };
    const sessions = listRecentSessions({ home, cliDbPath: readSessionDatabasePath(app), tasksDbPath });
    expect(sessions.map((session) => session.id)).toEqual(["sess_custom"]);
  });

  test("excludes requested ids (the current session)", () => {
    const db = createCliDb();
    insertSession(db, { id: "sess_current", title: "current" });
    insertSession(db, { id: "sess_other", title: "other" });
    db.close();
    const sessions = listRecentSessions({
      home,
      cliDbPath,
      tasksDbPath,
      excludeIds: new Set(["sess_current"])
    });
    expect(sessions.map((session) => session.id)).toEqual(["sess_other"]);
  });

  test("prefers desktop titles and tags desktop sessions", () => {
    const db = createCliDb();
    insertSession(db, {
      id: "sess_desktop",
      title: "cli title",
      directory: join(home, ".zcode", "workspace", "default"),
      messages: 3
    });
    db.close();
    const tasks = createTasksDb();
    tasks.prepare(
      "INSERT INTO tasks (workspace_key, task_id, title, pinned, archived, deleted) VALUES ('/ws', 'sess_desktop', 'desktop title', 1, 0, 0)"
    ).run();
    tasks.close();
    const sessions = listRecentSessions({ home, cliDbPath, tasksDbPath });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.title).toBe("desktop title");
    expect(sessions[0]?.source).toBe("desktop");
    expect(sessions[0]?.pinned).toBe(true);
  });

  test("tags desktop workspace sessions even without a task index entry", () => {
    const db = createCliDb();
    insertSession(db, {
      id: "sess_ws",
      title: "workspace session",
      directory: join(home, ".zcode", "workspace", "draft-abc")
    });
    db.close();
    const sessions = listRecentSessions({ home, cliDbPath, tasksDbPath });
    expect(sessions[0]?.source).toBe("desktop");
  });

  test("multi-line titles collapse to their first line", () => {
    const db = createCliDb();
    insertSession(db, { id: "sess_multi", title: "first line\nsecond line" });
    db.close();
    const sessions = listRecentSessions({ home, cliDbPath, tasksDbPath });
    expect(sessions[0]?.title).toBe("first line");
  });

  test("keeps working when the desktop task index is unreadable", () => {
    const db = createCliDb();
    insertSession(db, { id: "sess_plain", title: "plain" });
    db.close();
    writeFileSync(tasksDbPath, "not a database");
    const sessions = listRecentSessions({ home, cliDbPath, tasksDbPath });
    expect(sessions.map((session) => session.id)).toEqual(["sess_plain"]);
  });
});

function sessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sess_previous",
    title: "Fix parser",
    directory: "/tmp/project-b",
    timeUpdated: 1_700_000_000_000,
    messageCount: 3,
    source: "cli",
    pinned: false,
    archived: false,
    ...overrides
  };
}

describe("session picker choices", () => {
  test.each([false, true])("filters title substrings, directories and ids with pinned=%s", async (pinned) => {
    const session = sessionSummary({ pinned });
    for (const query of ["Fix", "PARSER", "/tmp/project-b", "sess_previous", "PREVIOUS"]) {
      const host = new Container();
      const ui = {
        terminal: { columns: 100, rows: 24 },
        requestRender() {},
        setFocus() {}
      } as unknown as TUI;
      const pending = choose(ui, host, createTheme(false), {
        title: "Sessions",
        prompt: "2 recent sessions",
        filterMode: "substring",
        items: [
          sessionChoiceItem(sessionSummary({ id: "sess_other", title: "Other task", directory: "/tmp/project-a" })),
          sessionChoiceItem(session)
        ]
      });
      for (const character of query) host.children[0]?.handleInput?.(character);
      const rendered = host.render(100).join("\n");
      expect(rendered).toContain("Fix parser");
      expect(rendered).not.toContain("Other task");
      expect(rendered).not.toContain("No matching commands");
      host.children[0]?.handleInput?.("\r");
      expect(await pending).toMatchObject({ value: session.id, payload: session });
    }
  });

  test.each(["title", "directory", "id"] as const)("sanitizes terminal commands in preview %s", (field) => {
    const session = sessionSummary({
      [field]: "Visible text\x1b]52;c;cHIyNTg=\x07\x1b]0;unsafe-title\x1b\\\x1b[2J\x1b[31m"
    });
    const rendered = sessionPreview(session, "/tmp/project-a").render(100).join("\n");
    expect(rendered).toContain("Visible text");
    expect(rendered).not.toContain("\x1b");
    expect(rendered).not.toContain("\x07");
    expect(rendered).not.toContain("unsafe-title");
    expect(rendered).toContain("This session belongs to another directory.");
  });

  test("keeps terminal commands out of the rendered choice dialog", async () => {
    const sequence = "\x1b]52;c;cHIyNTg=\x07";
    const session = sessionSummary({ title: `Fix parser${sequence}`, directory: `/tmp/project-b${sequence}` });
    const host = new Container();
    const ui = {
      terminal: { columns: 100, rows: 24 },
      requestRender() {},
      setFocus() {}
    } as unknown as TUI;
    const pending = choose(ui, host, createTheme(false), {
      title: "Sessions",
      prompt: "1 recent session",
      filterMode: "substring",
      items: [sessionChoiceItem(session)]
    });
    expect(host.render(100).join("\n")).not.toContain(sequence);
    host.children[0]?.handleInput?.("\x1b");
    expect(await pending).toBeNull();
  });
});

describe("formatSessionTimestamp", () => {
  test("formats epoch milliseconds as local YYYY-MM-DD HH:mm", () => {
    const stamp = new Date(2026, 10, 3, 15, 42).getTime();
    expect(formatSessionTimestamp(stamp)).toBe("2026-11-03 15:42");
  });

  test("renders ? for invalid timestamps", () => {
    expect(formatSessionTimestamp(Number.NaN)).toBe("?");
  });
});
