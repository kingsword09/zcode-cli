import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliSettingsPath, ensureCliSettings } from "../../src/model-access.ts";
import { writeProviderFixture } from "../fixtures/provider-config.ts";
import { runtimeStartupTimeoutMs, runtimeTestEnv } from "../fixtures/runtime-env.ts";
import { TerminalScreen } from "../tui/harness/terminal-screen.ts";

async function createFixture(display = "regular", databaseOverride?: "settings" | "environment") {
  const directory = await mkdtemp(join(tmpdir(), "zcode-session-lifecycle-"));
  const root = join(import.meta.dir, "../..");
  const node = Bun.which("node")!;
  const requests: string[] = [];
  let rejectRequests = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; model: string };
    if (body.stream) requests.push(body.model);
    if (rejectRequests) return Response.json({ error: { message: "Lifecycle request rejected" } }, { status: 400 });
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "Generated lifecycle title" }, finish_reason: "stop" }] });
    return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"LIFECYCLE_REPLY"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } });
  } });
  const databasePath = databaseOverride ? join(directory, "custom-sessions.sqlite") : join(directory, ".zcode/cli/db/db.sqlite");
  const env = {
    ...runtimeTestEnv(directory), ZCODE_NODE: node, ZCODE_TUI_MODE: display, TERM: "xterm-256color", CI: "0",
    ...databaseOverride === "environment" ? { ZCODE_SESSION_DB_PATH: databasePath } : {}
  };
  const children: Bun.Subprocess[] = [];
  const terminals: Bun.Terminal[] = [];
  const screens: TerminalScreen[] = [];
  const dispose = async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }
    for (const terminal of terminals) terminal.close();
    for (const screen of screens) { await screen.settled(); screen[Symbol.dispose](); }
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await ensureCliSettings(env);
    const settings = JSON.parse(await readFile(cliSettingsPath(env), "utf8"));
    settings.plugins.enabled = false;
    settings.memory = { use: false, write: false, autoConsolidate: false };
    settings.ui.locale = "en-US";
    if (databaseOverride) {
      settings.storage = {
        ...settings.storage,
        sessionDbPath: databaseOverride === "settings" ? databasePath : join(directory, "ignored-settings.sqlite")
      };
    }
    await writeFile(cliSettingsPath(env), JSON.stringify(settings));
    await writeProviderFixture(env, { apiKey: "fixture-key", modelId: "fixture", baseUrl: `${server.url.origin}/v1` });
    const command = [node, join(root, "bin/zcode.js")];
    const query = <Result>(sql: string, ...params: string[]): Result => {
      const connection = new Database(databasePath);
      try { return connection.query(sql).get(...params) as Result; }
      finally { connection.close(); }
    };
    const start = (args: string[] = [], workingDirectory = directory) => {
      const screen = new TerminalScreen(100, 32);
      screens.push(screen);
      const terminal = new Bun.Terminal({ cols: 100, rows: 32, name: "xterm-256color", data(_terminal, data) { void screen.write(data); } });
      terminals.push(terminal);
      const child = Bun.spawn([...command, ...args], { cwd: workingDirectory, env, terminal });
      children.push(child);
      const deadline = setTimeout(() => child.kill("SIGKILL"), 25_000);
      void child.exited.then(() => clearTimeout(deadline));
      const wait = async (predicate: (text: string) => boolean, timeoutMs = 8_000) => {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until && child.exitCode === null) {
          await screen.settled();
          if (predicate(screen.bufferText())) return;
          await Bun.sleep(25);
        }
        throw new Error(`Session lifecycle did not settle:\n${screen.bufferText()}`);
      };
      const exit = async () => {
        terminal.write("/exit\r");
        expect(await child.exited).toBe(0);
        await screen.settled();
        return screen.bufferText();
      };
      return { child, screen, terminal, wait, exit };
    };
    const print = async (args: string[]) => {
      const child = Bun.spawn([...command, ...args], { cwd: directory, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      children.push(child);
      const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return { code, output: stdout + stderr };
      } finally { clearTimeout(deadline); }
    };
    return { directory, databasePath, start, print, query, requests, rejectRequests: () => { rejectRequests = true; }, [Symbol.asyncDispose]: dispose };
  } catch (error) { await dispose(); throw error; }
}

async function createWorkspace(directory: string, branch: string, fileName: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr || stdout).toBe(0);
  };
  await git(["init", "-q", "-b", branch]);
  await writeFile(join(directory, fileName), "original\n");
  await git(["add", "--", fileName]);
  await git(["-c", "user.name=Workspace Test", "-c", "user.email=workspace@example.invalid", "commit", "-qm", "Initial file"]);
  await writeFile(join(directory, fileName), "updated\n");
}

test.skipIf(process.platform === "win32").each(["regular"])(
  "untouched %s sessions stay unsaved and omit resume guidance", async display => {
    await using fixture = await createFixture(display);
    const tui = fixture.start();
    await tui.wait(text => text.includes("◈ custom/fixture"), runtimeStartupTimeoutMs);
    const output = await tui.exit();
    expect(output).not.toContain("To continue this session");
    expect(fixture.query<{ count: number }>("SELECT count(*) AS count FROM session").count).toBe(0);
    expect(fixture.requests).toEqual([]);
  }, 30_000
);

test.skipIf(process.platform === "win32").each(["regular"])(
  "renaming an empty %s session saves its title and supports restart and headless resume", async display => {
    await using fixture = await createFixture(display);
    const tui = fixture.start();
    await tui.wait(text => text.includes("◈ custom/fixture"), runtimeStartupTimeoutMs);
    tui.terminal.write("/rename Chosen empty title\r");
    await tui.wait(text => text.includes("Session renamed to: Chosen empty title"));
    const row = fixture.query<{ id: string; title: string; title_source: string }>("SELECT id,title,title_source FROM session");
    expect(row.title).toBe("Chosen empty title");
    expect(row.title_source).toBe("custom");
    expect(fixture.query<{ count: number }>("SELECT count(*) AS count FROM message").count).toBe(0);
    expect(fixture.requests).toEqual([]);
    expect(await tui.exit()).toContain(`zcode --resume ${row.id}`);
    const resumed = fixture.start(["--resume", row.id]);
    await resumed.wait(text => text.includes("◈ custom/fixture"), runtimeStartupTimeoutMs);
    await resumed.screen.settled();
    expect(resumed.screen.bufferText()).not.toContain("Could not read execution state");
    expect(resumed.screen.title()).toContain("Chosen empty title");
    resumed.terminal.write("Reply after restarting.\r");
    await resumed.wait(text => text.includes("LIFECYCLE_REPLY"));
    expect(await resumed.exit()).toContain(`zcode --resume ${row.id}`);
    const printed = await fixture.print(["--resume", row.id, "-p", "Reply in print mode."]);
    expect(printed.code).toBe(0);
    expect(printed.output).toContain("LIFECYCLE_REPLY");
    expect(fixture.query<{ title: string }>("SELECT title FROM session WHERE id=?", row.id).title).toBe("Chosen empty title");
  }, 30_000
);

test.skipIf(process.platform === "win32")("invalid resume fails before startup and preserves the current interactive session", async () => {
  await using fixture = await createFixture();
  const missing = "sess_missing_lifecycle";
  const startup = fixture.start(["--resume", missing]);
  expect(await startup.child.exited).toBe(1);
  await startup.screen.settled();
  expect(startup.screen.bufferText()).toContain(`Session not found: ${missing}`);
  expect(startup.screen.bufferText()).not.toContain("Could not read execution state");
  const printed = await fixture.print(["--resume", missing, "-p", "Do not send this."]);
  expect(printed.code).toBe(1);
  expect(printed.output).toContain(`Session not found: ${missing}`);
  const tui = fixture.start();
  await tui.wait(text => text.includes("◈ custom/fixture"), runtimeStartupTimeoutMs);
  tui.terminal.write("/rename Original session\r");
  await tui.wait(text => text.includes("Session renamed to: Original session"));
  const original = fixture.query<{ id: string }>("SELECT id FROM session").id;
  tui.terminal.write(`/resume ${missing}\r`);
  await tui.wait(text => text.includes(`Session not found: ${missing}`));
  tui.terminal.write("/rename Still original\r");
  await tui.wait(text => text.includes("Session renamed to: Still original"));
  expect(fixture.query<{ title: string }>("SELECT title FROM session WHERE id=?", original).title).toBe("Still original");
  tui.terminal.write("Reply from the preserved session.\r");
  await tui.wait(text => text.includes("LIFECYCLE_REPLY"));
  expect(await tui.exit()).toContain(`zcode --resume ${original}`);
  expect(fixture.query<{ count: number }>("SELECT count(*) AS count FROM session").count).toBe(1);
}, 30_000);

test.skipIf(process.platform === "win32")("a failed first request still saves a resumable session without a custom title", async () => {
  await using fixture = await createFixture();
  fixture.rejectRequests();
  const tui = fixture.start();
  await tui.wait(text => text.includes("◈ custom/fixture"), runtimeStartupTimeoutMs);
  tui.terminal.write("First prompt should name this session\r");
  await tui.wait(text => text.includes("Turn execution failed"));
  const row = fixture.query<{ id: string; title: string; title_source: string }>("SELECT id,title,title_source FROM session");
  expect(row.title).toContain("First prompt should name this session");
  expect(row.title_source).not.toBe("custom");
  expect(await tui.exit()).toContain(`zcode --resume ${row.id}`);
}, 30_000);

test.skipIf(process.platform === "win32").each([
  ["regular", "settings"],
  ["regular", "environment"],
  ["fullscreen", "settings"],
  ["fullscreen", "environment"]
] as const)(
  "/sessions in %s uses the %s database override and filters and resumes a pinned cross-directory fork", async (display, databaseOverride) => {
    await using fixture = await createFixture(display, databaseOverride);
    const launchDirectory = join(fixture.directory, "launch-project");
    const otherDirectory = join(fixture.directory, "other-project");
    const workflowDirectory = join(fixture.directory, "workflow-project");
    await createWorkspace(launchDirectory, "launch-branch", "launch-change.txt");
    await createWorkspace(otherDirectory, "resumed-branch", "resumed-change.txt");
    await mkdir(workflowDirectory);
    const tui = fixture.start([], launchDirectory);
    await tui.wait(text => text.includes("◈ custom/fixture"), runtimeStartupTimeoutMs);
    await tui.wait(() => tui.screen.screenText().includes("/launch-project"));
    tui.terminal.write("/rename Current picker session\r");
    await tui.wait(text => text.includes("Session renamed to: Current picker session"));
    const originalId = fixture.query<{ id: string }>("SELECT id FROM session").id;
    const database = new Database(fixture.databasePath);
    try {
      const insert = database.prepare(`
        INSERT INTO session (id, project_id, slug, directory, path, title, version, permission,
                             time_created, time_updated, task_type, title_source, trace_id, parent_id)
        SELECT ?, project_id, ?, ?, ?, ?, version, permission,
               time_created, ?, ?, 'custom', trace_id, ? FROM session WHERE id = ?
      `);
      const chatDirectory = join(fixture.directory, "chat-project");
      insert.run("sess_picker_chat", "picker-chat", chatDirectory, chatDirectory, "Earlier chat", 1_000, "interactive", null, originalId);
      insert.run("sess_picker_fork", "picker-fork", otherDirectory, otherDirectory, "Repair parser regression", 2_000, "fork", originalId, originalId);
      insert.run("sess_picker_workflow", "picker-workflow", workflowDirectory, workflowDirectory, "Workflow summary", 3_000, "workflow_parent", null, originalId);
    } finally {
      database.close();
    }
    const tasks = new Database(join(fixture.directory, ".zcode/v2/tasks-index.sqlite"));
    try {
      tasks.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT, pinned INTEGER, archived INTEGER, deleted INTEGER)");
      tasks.prepare("INSERT INTO tasks VALUES (?, ?, 1, 0, 0)").run("sess_picker_fork", "Repair parser regression");
    } finally {
      tasks.close();
    }
    for (const query of ["PARSER", "other-project", "sess_picker_fork"]) {
      tui.terminal.write("/sessions\r");
      await tui.wait(() => {
        const text = tui.screen.screenText();
        return text.includes("3 recent sessions · Enter resumes in place") && text.includes("Workflow summary")
          && text.includes("Earlier chat") && text.includes("★ Repair parser regression");
      });
      expect(tui.screen.screenText()).toContain("Workflow summary");
      expect(tui.screen.screenText()).toContain("Earlier chat");
      expect(tui.screen.screenText()).toContain("★ Repair parser regression");
      tui.terminal.write(query);
      await tui.wait(() => {
        const text = tui.screen.screenText();
        return text.includes(`Filter: ${query}`) && text.includes("Repair parser regression")
          && !text.includes("Workflow summary") && !text.includes("Earlier chat");
      });
      if (query === "sess_picker_fork") {
        tui.terminal.write("\r");
      } else {
        tui.terminal.write("\x1b");
        await Bun.sleep(500);
      }
    }
    await tui.wait(() => tui.screen.title().includes("Repair parser regression"));
    await tui.wait(() => tui.screen.screenText().includes("/other-project") && tui.screen.screenText().includes("resumed-branch"));
    expect(tui.screen.screenText()).not.toContain("launch-branch");
    tui.terminal.write("/status\r");
    await tui.wait(() => {
      const text = tui.screen.screenText();
      return text.includes("Detailed session information") && text.includes("other-project") && text.includes("resumed-branch");
    });
    expect(tui.screen.screenText()).toContain("other-project");
    expect(tui.screen.screenText()).toContain("resumed-branch");
    expect(tui.screen.screenText()).not.toContain("launch-branch");
    tui.terminal.write("\x1b");
    await Bun.sleep(100);
    tui.terminal.write("/diff\r");
    await tui.wait(() => tui.screen.screenText().includes("Select current workspace changes"));
    tui.terminal.write("\r");
    await tui.wait(() => tui.screen.screenText().includes("resumed-change.txt"));
    expect(tui.screen.screenText()).not.toContain("launch-change.txt");
    tui.terminal.write("\x1b");
    await tui.wait(() => tui.screen.screenText().includes("Select current workspace changes"));
    tui.terminal.write("\x1b");
    await Bun.sleep(100);
    for (const token of ["@resumed-", "@./resumed-"]) {
      await tui.wait(() => !tui.screen.screenText().includes("resumed-change.txt"));
      tui.terminal.write(token);
      await tui.wait(() => tui.screen.screenText().includes("resumed-change.txt"));
      expect(tui.screen.screenText()).not.toContain("launch-change.txt");
      tui.terminal.write("\x1b");
      await Bun.sleep(100);
      tui.terminal.write("\x15");
      await Bun.sleep(100);
    }
    await tui.wait(() => !tui.screen.screenText().includes("resumed-change.txt"));
    tui.terminal.write("./resumed-");
    await Bun.sleep(100);
    tui.terminal.write("\t");
    await tui.wait(() => tui.screen.screenText().includes("./resumed-change.txt"));
    tui.terminal.write("\x15");
    tui.terminal.write("/rename Resumed picker fork\r");
    await tui.wait(text => text.includes("Session renamed to: Resumed picker fork"));
    expect(fixture.query<{ title: string }>("SELECT title FROM session WHERE id = ?", "sess_picker_fork").title).toBe("Resumed picker fork");
    expect(fixture.query<{ title: string }>("SELECT title FROM session WHERE id = ?", originalId).title).toBe("Current picker session");
    expect(fixture.requests).toEqual([]);
    expect(await tui.exit()).toContain("zcode --resume sess_picker_fork");

    const startup = fixture.start(["--resume", "sess_picker_fork"], launchDirectory);
    await startup.wait(() => startup.screen.screenText().includes("/other-project") && startup.screen.screenText().includes("resumed-branch"), runtimeStartupTimeoutMs);
    expect(startup.screen.screenText()).not.toContain("launch-branch");
    startup.terminal.write("/resume sess_missing_workspace\r");
    await startup.wait(text => text.includes("Session not found: sess_missing_workspace"));
    expect(startup.screen.screenText()).toContain("resumed-branch");
    startup.terminal.write("/resume sess_picker_workflow\r");
    await startup.wait(() => startup.screen.screenText().includes("/workflow-project"));
    expect(startup.screen.screenText()).not.toContain("resumed-branch");
    startup.terminal.write("/new\r");
    await startup.wait(() => startup.screen.screenText().includes("/launch-project") && startup.screen.screenText().includes("launch-branch"));
    expect(startup.screen.screenText()).not.toContain("resumed-branch");
    expect(fixture.requests).toEqual([]);
    await startup.exit();
  }, 30_000
);
